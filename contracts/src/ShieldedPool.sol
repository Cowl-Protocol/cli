// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IVerifier} from "./ShieldVerifier.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// The Cowl shielded pool — deposits only, for now. `shield` takes a public
/// token + value and a note commitment, and the UltraHonk proof binds them:
///
///   commitment = Poseidon2(mpk, token, value, blinding)   (circuits/shield)
///
/// mpk and blinding never touch the chain, so once the note is committed,
/// nothing links a later spend back to this deposit. Without the proof a
/// depositor could commit to a note worth more than the deposit and drain the
/// pool on withdrawal — the proof is the peg between what came in and what the
/// note claims to hold.
///
/// Commitments are an append-only log (events). Clients rebuild the depth-20
/// Poseidon2 Merkle tree off-chain — the CLI already does. The on-chain root
/// bookkeeping arrives with the spend circuits (unshield/trade), which are the
/// first thing to need it.
///
/// Token convention, shared with the CLI (cli/src/shielded/tokens.ts):
/// token id 0 is the native coin; anything else is the ERC-20 address as a
/// field element.
contract ShieldedPool {
    /// BN254 Fr — public inputs must be canonical field elements, or a value
    /// of p + x would alias x inside the verifier's field arithmetic.
    uint256 internal constant FR =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint32 public constant TREE_DEPTH = 20;
    uint32 public constant MAX_LEAVES = uint32(1) << TREE_DEPTH;

    IVerifier public immutable verifier;

    uint32 public nextLeafIndex;
    mapping(bytes32 => bool) public committed;

    /// Only what a client needs to rebuild the tree. The deposit's token and value
    /// are deliberately absent: they are already public on the deposit path
    /// (calldata, msg.value, the ERC-20 Transfer), so repeating them in the log
    /// bought nothing and left a permanently indexed, trivially queryable record
    /// beside the commitment. Deposits are not private — but a spend of this note
    /// later should not be handed a matching amount to be joined against.
    event NoteCommitted(bytes32 indexed commitment, uint32 leafIndex);

    error DuplicateCommitment();
    error TreeFull();
    error ZeroValue();
    error NotAField();
    error WrongDeposit();
    error InvalidProof();
    error TransferFailed();

    constructor(IVerifier _verifier) {
        verifier = _verifier;
    }

    function shield(uint256 token, uint256 value, bytes32 commitment, bytes calldata proof)
        external
        payable
    {
        if (value == 0) revert ZeroValue();
        if (value >= FR || uint256(commitment) >= FR) revert NotAField();
        // Non-native token ids are ERC-20 addresses; anything wider would
        // silently truncate in the uint160 cast below while the proof commits
        // to the full field element.
        if (token > type(uint160).max) revert NotAField();
        if (committed[commitment]) revert DuplicateCommitment();
        if (nextLeafIndex >= MAX_LEAVES) revert TreeFull();

        // Effects before the proof + funds pull: commitment can never be
        // replayed even through reentrancy.
        committed[commitment] = true;
        uint32 leafIndex = nextLeafIndex++;

        bytes32[] memory publicInputs = new bytes32[](3);
        publicInputs[0] = bytes32(token);
        publicInputs[1] = bytes32(value);
        publicInputs[2] = commitment;
        if (!verifier.verify(proof, publicInputs)) revert InvalidProof();

        if (token == 0) {
            if (msg.value != value) revert WrongDeposit();
        } else {
            if (msg.value != 0) revert WrongDeposit();
            if (!IERC20(address(uint160(token))).transferFrom(msg.sender, address(this), value)) {
                revert TransferFailed();
            }
        }

        emit NoteCommitted(commitment, leafIndex);
    }
}
