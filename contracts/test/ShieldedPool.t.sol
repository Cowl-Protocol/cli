// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier, HonkVerifier} from "../src/ShieldVerifier.sol";

contract MockVerifier is IVerifier {
    bool public result = true;

    function set(bool r) external {
        result = r;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return result;
    }
}

contract ShieldedPoolTest is Test {
    // The smoke-test vector from circuits/shield/Prover.toml:
    // Poseidon2(mpk=1, token=2, value=3, blinding=4).
    bytes32 constant COMMITMENT =
        0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9;
    uint256 constant FR =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MockVerifier verifier;
    ShieldedPool pool;

    event NoteCommitted(bytes32 indexed commitment, uint32 leafIndex, uint256 token, uint256 value);

    function setUp() public {
        verifier = new MockVerifier();
        pool = new ShieldedPool(IVerifier(address(verifier)));
    }

    function test_shield_native_commits_and_emits() public {
        vm.expectEmit();
        emit NoteCommitted(COMMITMENT, 0, 0, 3);
        pool.shield{value: 3}(0, 3, COMMITMENT, "");
        assertTrue(pool.committed(COMMITMENT));
        assertEq(pool.nextLeafIndex(), 1);
        assertEq(address(pool).balance, 3);
    }

    function test_shield_rejects_duplicate_commitment() public {
        pool.shield{value: 3}(0, 3, COMMITMENT, "");
        vm.expectRevert(ShieldedPool.DuplicateCommitment.selector);
        pool.shield{value: 3}(0, 3, COMMITMENT, "");
    }

    function test_shield_rejects_wrong_native_amount() public {
        vm.expectRevert(ShieldedPool.WrongDeposit.selector);
        pool.shield{value: 2}(0, 3, COMMITMENT, "");
    }

    function test_shield_rejects_invalid_proof() public {
        verifier.set(false);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.shield{value: 3}(0, 3, COMMITMENT, "");
    }

    function test_shield_rejects_zero_value() public {
        vm.expectRevert(ShieldedPool.ZeroValue.selector);
        pool.shield(0, 0, COMMITMENT, "");
    }

    function test_shield_rejects_noncanonical_field() public {
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield{value: 0}(0, FR, COMMITMENT, "");
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield{value: 3}(0, 3, bytes32(FR), "");
    }

    function test_shield_rejects_oversized_token_id() public {
        uint256 wide = (uint256(1) << 160) | 0x1111;
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield(wide, 3, COMMITMENT, "");
    }

    function test_shield_rejects_eth_sent_with_erc20_deposit() public {
        vm.expectRevert(ShieldedPool.WrongDeposit.selector);
        pool.shield{value: 3}(0x1111, 3, COMMITMENT, "");
    }
}

/// The real thing: the bb-emitted HonkVerifier fed the proof bb generated for
/// circuits/shield (the ProverNative witness — a native-coin deposit, so the
/// pool takes the msg.value path). If this passes, the whole chain holds —
/// note math in JS, circuit in Noir, proof by bb, verification in the EVM.
contract ShieldedPoolIntegrationTest is Test {
    // Poseidon2(mpk=1, token=0, value=3, blinding=4), pinned in ProverNative.toml.
    bytes32 constant COMMITMENT =
        0x0087943cdbcce40307e143be7ff6091f2116484a4adf3f8c4d4f27f5e20375ac;

    ShieldedPool pool;
    bytes proof;

    function setUp() public {
        pool = new ShieldedPool(IVerifier(address(new HonkVerifier())));
        proof = vm.readFileBinary("../circuits/target/shield-evm-native/proof");
    }

    function test_real_proof_shields() public {
        pool.shield{value: 3}(0, 3, COMMITMENT, proof);
        assertTrue(pool.committed(COMMITMENT));
        assertEq(address(pool).balance, 3);
    }

    function test_real_proof_with_wrong_value_reverts() public {
        // Same proof, tampered public input — the verifier must refuse.
        vm.expectRevert();
        pool.shield{value: 4}(0, 4, COMMITMENT, proof);
    }

    function test_garbage_proof_reverts() public {
        bytes memory garbage = new bytes(proof.length);
        vm.expectRevert();
        pool.shield{value: 3}(0, 3, COMMITMENT, garbage);
    }
}
