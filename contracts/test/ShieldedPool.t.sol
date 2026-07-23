// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier, ShieldVerifier} from "../src/ShieldVerifier.sol";
import {TransferVerifier} from "../src/TransferVerifier.sol";

/// A note ciphertext the pool will accept. It is opaque to the contract, so a
/// blob of the right width is all these tests need — the width itself is what
/// test_shield_rejects_a_wrong_length_cipher and its spend twin check.
function okCipher() pure returns (bytes memory) {
    return new bytes(158);
}

function okCiphers() pure returns (bytes[2] memory cts) {
    cts[0] = okCipher();
    cts[1] = okCipher();
}

contract MockVerifier is IVerifier {
    bool public result = true;

    function set(bool r) external {
        result = r;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return result;
    }
}

/// A no-frills ERC-20 for the per-token turnstile tests. It ignores allowances —
/// the pool's accounting, not the token's, is what these tests exercise.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Everything the pool enforces on its own, with the proof stubbed out. The
/// circuits are checked separately (nargo test) and end to end below.
contract ShieldedPoolTest is Test {
    uint256 constant FR =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Public inputs have to be canonical field elements, and a raw keccak hash
    /// is not one. Shifting off the top byte lands every fixture below FR.
    function _f(string memory label) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(bytes(label))) >> 8);
    }

    MockVerifier shieldVerifier;
    MockVerifier transferVerifier;
    ShieldedPool pool;

    event NoteCommitted(bytes32 indexed commitment, uint32 leafIndex);
    event NoteCipher(uint32 leafIndex, bytes ciphertext);
    event Nullified(bytes32 indexed nullifier);

    function setUp() public {
        shieldVerifier = new MockVerifier();
        transferVerifier = new MockVerifier();
        pool = new ShieldedPool(
            IVerifier(address(shieldVerifier)), IVerifier(address(transferVerifier))
        );
    }

    // ------------------------------------------------------------- shield ---

    function test_starts_at_the_empty_root() public view {
        assertEq(pool.root(), pool.EMPTY_ROOT());
        assertTrue(pool.knownRoot(pool.EMPTY_ROOT()));
        assertEq(pool.nextLeafIndex(), 0);
    }

    function test_shield_native_commits_and_advances_the_root() public {
        bytes memory cipher = okCipher();
        vm.expectEmit();
        emit NoteCommitted(_f("commitment"), 0);
        vm.expectEmit();
        emit NoteCipher(0, cipher);
        pool.shield{value: 3}(0, 3, _f("commitment"), _f("root-1"), cipher, "");

        assertTrue(pool.committed(_f("commitment")));
        assertEq(pool.nextLeafIndex(), 1);
        assertEq(pool.root(), _f("root-1"));
        assertTrue(pool.knownRoot(_f("root-1")));
        // The root the tree grew out of stays spendable.
        assertTrue(pool.knownRoot(pool.EMPTY_ROOT()));
        assertEq(address(pool).balance, 3);
    }

    function test_shield_rejects_duplicate_commitment() public {
        pool.shield{value: 3}(0, 3, _f("commitment"), _f("root-1"), okCipher(), "");
        vm.expectRevert(ShieldedPool.DuplicateCommitment.selector);
        pool.shield{value: 3}(0, 3, _f("commitment"), _f("root-2"), okCipher(), "");
    }

    function test_shield_rejects_wrong_native_amount() public {
        vm.expectRevert(ShieldedPool.WrongDeposit.selector);
        pool.shield{value: 2}(0, 3, _f("commitment"), _f("root-1"), okCipher(), "");
    }

    function test_shield_rejects_invalid_proof() public {
        shieldVerifier.set(false);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.shield{value: 3}(0, 3, _f("commitment"), _f("root-1"), okCipher(), "");
    }

    function test_shield_rejects_zero_value() public {
        vm.expectRevert(ShieldedPool.ZeroValue.selector);
        pool.shield(0, 0, _f("commitment"), _f("root-1"), okCipher(), "");
    }

    function test_shield_rejects_a_wrong_length_cipher() public {
        vm.expectRevert(ShieldedPool.BadCipherLength.selector);
        pool.shield{value: 3}(0, 3, _f("commitment"), _f("root-1"), new bytes(157), "");
    }

    function test_shield_rejects_noncanonical_field() public {
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield{value: 0}(0, FR, _f("commitment"), _f("root-1"), okCipher(), "");
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield{value: 3}(0, 3, bytes32(FR), _f("root-1"), okCipher(), "");
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield{value: 3}(0, 3, _f("commitment"), bytes32(FR), okCipher(), "");
    }

    function test_shield_rejects_oversized_token_id() public {
        uint256 wide = (uint256(1) << 160) | 0x1111;
        vm.expectRevert(ShieldedPool.NotAField.selector);
        pool.shield(wide, 3, _f("commitment"), _f("root-1"), okCipher(), "");
    }

    function test_shield_rejects_eth_sent_with_erc20_deposit() public {
        vm.expectRevert(ShieldedPool.WrongDeposit.selector);
        pool.shield{value: 3}(0x1111, 3, _f("commitment"), _f("root-1"), okCipher(), "");
    }

    // -------------------------------------------------------------- spend ---

    function _spend() internal view returns (ShieldedPool.Spend memory s) {
        s.membershipRoot = pool.root();
        s.nullifiers = [_f("n0"), _f("n1")];
        s.commitments = [_f("c0"), _f("c1")];
        s.newRoot = _f("root-next");
        s.token = 0;
        s.value = 250;
        s.fee = 50;
        s.recipient = address(0xB0B);
        s.relayer = address(0xC0FFEE);
    }

    function _fundedPool() internal returns (ShieldedPool.Spend memory s) {
        pool.shield{value: 1000}(0, 1000, _f("commitment"), _f("root-1"), okCipher(), "");
        s = _spend();
    }

    function test_spend_nullifies_appends_and_pays_out() public {
        ShieldedPool.Spend memory s = _fundedPool();

        vm.expectEmit();
        emit Nullified(s.nullifiers[0]);
        pool.spend(s, okCiphers(), "");

        assertTrue(pool.nullifierSpent(s.nullifiers[0]));
        assertTrue(pool.nullifierSpent(s.nullifiers[1]));
        assertTrue(pool.committed(s.commitments[0]));
        assertEq(pool.nextLeafIndex(), 3); // leaf 0 was the deposit
        assertEq(pool.root(), s.newRoot);
        assertEq(s.recipient.balance, 250);
        assertEq(s.relayer.balance, 50);
        assertEq(address(pool).balance, 700);
    }

    /// Both outputs get a cipher, paired to their leaf. Emitting one per output —
    /// including the change note back to the sender — is what keeps an observer
    /// from telling the payment leg from the change leg by which one was
    /// delivered.
    function test_spend_emits_a_cipher_for_each_output() public {
        ShieldedPool.Spend memory s = _fundedPool();
        bytes[2] memory cts = okCiphers();
        // leaf 0 was the deposit, so the two outputs land at 1 and 2.
        vm.expectEmit();
        emit Nullified(s.nullifiers[0]);
        vm.expectEmit();
        emit Nullified(s.nullifiers[1]);
        vm.expectEmit();
        emit NoteCommitted(s.commitments[0], 1);
        vm.expectEmit();
        emit NoteCipher(1, cts[0]);
        vm.expectEmit();
        emit NoteCommitted(s.commitments[1], 2);
        vm.expectEmit();
        emit NoteCipher(2, cts[1]);
        pool.spend(s, cts, "");
    }

    function test_spend_pays_nothing_when_the_legs_are_private() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.value = 0;
        s.fee = 0;
        pool.spend(s, okCiphers(), "");
        assertEq(address(pool).balance, 1000);
        assertEq(s.recipient.balance, 0);
    }

    function test_spend_rejects_a_root_the_pool_never_had() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.membershipRoot = _f("never");
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.spend(s, okCiphers(), "");
    }

    function test_spend_rejects_a_replayed_nullifier() public {
        ShieldedPool.Spend memory s = _fundedPool();
        pool.spend(s, okCiphers(), "");

        ShieldedPool.Spend memory again = _spend();
        again.membershipRoot = pool.root();
        again.commitments = [_f("c2"), _f("c3")];
        again.value = 0;
        again.fee = 0;
        vm.expectRevert(ShieldedPool.AlreadySpent.selector);
        pool.spend(again, okCiphers(), "");
    }

    function test_spend_rejects_the_same_nullifier_twice_in_one_tx() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.nullifiers[1] = s.nullifiers[0];
        vm.expectRevert(ShieldedPool.RepeatedNullifier.selector);
        pool.spend(s, okCiphers(), "");
    }

    function test_spend_rejects_a_commitment_already_in_the_tree() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.commitments[0] = _f("commitment");
        vm.expectRevert(ShieldedPool.DuplicateCommitment.selector);
        pool.spend(s, okCiphers(), "");
    }

    function test_spend_rejects_a_wrong_length_cipher() public {
        ShieldedPool.Spend memory s = _fundedPool();
        bytes[2] memory cts;
        cts[0] = okCipher();
        cts[1] = new bytes(1);
        vm.expectRevert(ShieldedPool.BadCipherLength.selector);
        pool.spend(s, cts, "");
    }

    function test_spend_rejects_a_payout_with_nowhere_to_go() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.recipient = address(0);
        vm.expectRevert(ShieldedPool.NoRecipient.selector);
        pool.spend(s, okCiphers(), "");
    }

    function test_spend_rejects_invalid_proof() public {
        ShieldedPool.Spend memory s = _fundedPool();
        transferVerifier.set(false);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.spend(s, okCiphers(), "");
    }

    /// History is a ring, so a note proven against a root older than the window
    /// has to be reproven against a current one.
    function test_root_history_evicts_the_oldest() public {
        bytes32 first = pool.EMPTY_ROOT();
        uint32 span = pool.ROOT_HISTORY();
        for (uint256 i = 0; i < span; i++) {
            pool.shield{value: 1}(0, 1, _f(string.concat("c", vm.toString(i))), _f(string.concat("r", vm.toString(i))), okCipher(), "");
        }
        assertFalse(pool.knownRoot(first));
        assertTrue(pool.knownRoot(pool.root()));
    }

    // ------------------------------------------- value-conservation cap ---
    //
    // The turnstile (Zcash ZIP-209): the pool tracks net custody per token and
    // never pays out more of a token than was ever deposited. This holds even
    // if a circuit soundness bug forged notes, so it bounds the blast radius of
    // any undiscovered counterfeit to one token's real deposits.

    function test_pooled_value_starts_at_zero() public view {
        assertEq(pool.pooledValue(0), 0);
    }

    function test_shield_credits_pooled_value() public {
        pool.shield{value: 1000}(0, 1000, _f("commitment"), _f("root-1"), okCipher(), "");
        assertEq(pool.pooledValue(0), 1000);
    }

    function test_spend_debits_pooled_value_by_value_plus_fee() public {
        ShieldedPool.Spend memory s = _fundedPool(); // 1000 in, then 250 + 50 out
        pool.spend(s, okCiphers(), "");
        assertEq(pool.pooledValue(0), 700);
    }

    function test_private_send_leaves_pooled_value_untouched() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.value = 0;
        s.fee = 0;
        pool.spend(s, okCiphers(), "");
        assertEq(pool.pooledValue(0), 1000);
    }

    function test_spend_cannot_withdraw_more_than_was_deposited() public {
        ShieldedPool.Spend memory s = _fundedPool(); // 1000 in
        s.value = 1000;
        s.fee = 50; // outflow 1050 > 1000
        vm.expectRevert(ShieldedPool.ExceedsPooledValue.selector);
        pool.spend(s, okCiphers(), "");
    }

    function test_spend_can_drain_exactly_to_zero() public {
        ShieldedPool.Spend memory s = _fundedPool();
        s.value = 950;
        s.fee = 50; // outflow 1000 == pooled
        pool.spend(s, okCiphers(), "");
        assertEq(pool.pooledValue(0), 0);
        assertEq(address(pool).balance, 0);
    }

    /// The turnstile is per token: a native deposit cannot back the withdrawal
    /// of a different asset, not even one wei of it.
    function test_turnstile_is_per_token() public {
        pool.shield{value: 1000}(0, 1000, _f("commitment"), _f("root-1"), okCipher(), "");
        ShieldedPool.Spend memory s = _spend();
        s.token = 0x1111; // an ERC-20 with nothing deposited
        s.value = 1;
        s.fee = 0;
        vm.expectRevert(ShieldedPool.ExceedsPooledValue.selector);
        pool.spend(s, okCiphers(), "");
    }

    /// A later withdrawal is bounded by whatever the earlier ones left behind.
    function test_turnstile_bounds_the_running_balance() public {
        ShieldedPool.Spend memory s = _fundedPool(); // 1000 in
        s.value = 600;
        s.fee = 0;
        pool.spend(s, okCiphers(), ""); // leaves 400
        assertEq(pool.pooledValue(0), 400);

        ShieldedPool.Spend memory again = _spend();
        again.membershipRoot = pool.root();
        again.nullifiers = [_f("m0"), _f("m1")];
        again.commitments = [_f("d0"), _f("d1")];
        again.value = 401; // over the remaining 400
        again.fee = 0;
        vm.expectRevert(ShieldedPool.ExceedsPooledValue.selector);
        pool.spend(again, okCiphers(), "");
    }

    function test_erc20_turnstile_tracks_and_bounds_per_token() public {
        MockERC20 tok = new MockERC20();
        uint256 id = uint256(uint160(address(tok)));
        tok.mint(address(this), 1000);
        pool.shield(id, 1000, _f("commitment"), _f("root-1"), okCipher(), "");
        assertEq(pool.pooledValue(id), 1000);
        assertEq(pool.pooledValue(0), 0); // native untouched

        ShieldedPool.Spend memory s = _spend();
        s.token = id;
        s.value = 300;
        s.fee = 50;
        pool.spend(s, okCiphers(), "");
        assertEq(pool.pooledValue(id), 650);
        assertEq(tok.balanceOf(s.recipient), 300);
        assertEq(tok.balanceOf(s.relayer), 50);

        ShieldedPool.Spend memory again = _spend();
        again.membershipRoot = pool.root();
        again.nullifiers = [_f("m0"), _f("m1")];
        again.commitments = [_f("d0"), _f("d1")];
        again.token = id;
        again.value = 651; // over the remaining 650
        again.fee = 0;
        vm.expectRevert(ShieldedPool.ExceedsPooledValue.selector);
        pool.spend(again, okCiphers(), "");
    }
}

/// The real thing: bb's own verifiers fed bb's own proofs, over fixtures built
/// by the CLI's note math (circuits/fixtures.mjs). A deposit of 1000 wei, then a
/// spend of that exact note paying 250 out and 50 to a relayer, leaving 700
/// shielded. If this passes, the whole chain holds — note math in JS, circuits in
/// Noir, proofs by bb, verification in the EVM, accounting in the pool.
contract ShieldedPoolIntegrationTest is Test {
    ShieldedPool pool;
    bytes shieldProof;
    bytes spendProof;
    bytes32[] shieldInputs;
    bytes32[] spendInputs;

    function setUp() public {
        // The transfer fixture is proven for Robinhood testnet (46630), and the
        // proof binds that chain id, so the pool must see the same block.chainid.
        vm.chainId(46630);
        pool = new ShieldedPool(
            IVerifier(address(new ShieldVerifier())), IVerifier(address(new TransferVerifier()))
        );
        shieldProof = vm.readFileBinary("../circuits/target/shield-fixture/proof");
        spendProof = vm.readFileBinary("../circuits/target/transfer-fixture/proof");
        shieldInputs = vm.parseJsonBytes32Array(
            vm.readFile("../circuits/target/shield-fixture/public_inputs.json"), ".publicInputs"
        );
        spendInputs = vm.parseJsonBytes32Array(
            vm.readFile("../circuits/target/transfer-fixture/public_inputs.json"), ".publicInputs"
        );
    }

    function _deposit() internal {
        pool.shield{value: uint256(shieldInputs[1])}(
            uint256(shieldInputs[0]), // token
            uint256(shieldInputs[1]), // value
            shieldInputs[2], // commitment
            shieldInputs[4], // new root
            okCipher(),
            shieldProof
        );
    }

    function _spend() internal view returns (ShieldedPool.Spend memory s) {
        s.membershipRoot = spendInputs[0];
        s.nullifiers = [spendInputs[1], spendInputs[2]];
        s.commitments = [spendInputs[3], spendInputs[4]];
        s.newRoot = spendInputs[6];
        s.token = uint256(spendInputs[8]);
        s.value = uint256(spendInputs[9]);
        s.fee = uint256(spendInputs[10]);
        s.recipient = address(uint160(uint256(spendInputs[11])));
        s.relayer = address(uint160(uint256(spendInputs[12])));
    }

    function test_fixture_deposit_starts_from_the_empty_root() public view {
        assertEq(shieldInputs[3], pool.EMPTY_ROOT());
    }

    function test_real_proof_shields() public {
        _deposit();
        assertTrue(pool.committed(shieldInputs[2]));
        assertEq(pool.root(), shieldInputs[4]);
        assertEq(pool.nextLeafIndex(), 1);
        assertEq(address(pool).balance, 1000);
    }

    function test_real_proof_spends_and_pays_out() public {
        _deposit();
        ShieldedPool.Spend memory s = _spend();

        pool.spend(s, okCiphers(), spendProof);

        assertEq(s.recipient.balance, 250);
        assertEq(s.relayer.balance, 50);
        assertEq(address(pool).balance, 700);
        assertEq(pool.nextLeafIndex(), 3);
        assertEq(pool.root(), s.newRoot);
        assertTrue(pool.nullifierSpent(s.nullifiers[0]));
    }

    function test_spend_proof_is_bound_to_its_recipient() public {
        _deposit();
        ShieldedPool.Spend memory s = _spend();
        // The whole point of binding recipient into the proof: a mempool
        // observer cannot re-point a pending unshield at themselves.
        s.recipient = address(0xBAD);
        vm.expectRevert();
        pool.spend(s, okCiphers(), spendProof);
    }

    function test_spend_proof_is_bound_to_its_chain() public {
        _deposit();
        ShieldedPool.Spend memory s = _spend();
        // The proof binds chain 46630; on any other chain the pool passes a
        // different block.chainid, so the same proof no longer verifies. This is
        // what stops a spend from being replayed on another instance of the pool.
        vm.chainId(999);
        vm.expectRevert();
        pool.spend(s, okCiphers(), spendProof);
    }

    function test_spend_proof_cannot_inflate_its_payout() public {
        _deposit();
        ShieldedPool.Spend memory s = _spend();
        s.value = 900;
        vm.expectRevert();
        pool.spend(s, okCiphers(), spendProof);
    }

    function test_spend_cannot_run_before_the_deposit_it_spends() public {
        // Without the deposit the pool is still at the empty root, so the
        // membership root the proof names is unknown to it.
        ShieldedPool.Spend memory s = _spend();
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.spend(s, okCiphers(), spendProof);
    }

    function test_real_proof_with_wrong_value_reverts() public {
        vm.expectRevert();
        pool.shield{value: 1001}(0, 1001, shieldInputs[2], shieldInputs[4], okCipher(), shieldProof);
    }

    function test_garbage_proof_reverts() public {
        bytes memory garbage = new bytes(shieldProof.length);
        vm.expectRevert();
        pool.shield{value: 1000}(0, 1000, shieldInputs[2], shieldInputs[4], okCipher(), garbage);
    }
}
