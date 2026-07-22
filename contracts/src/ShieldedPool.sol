// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IVerifier} from "./ShieldVerifier.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// The Cowl shielded pool.
///
/// Value enters through `shield` and moves through `spend`. A spend consumes up
/// to two notes and produces exactly two, optionally paying part of the value
/// out to a public address — which makes one entrypoint cover private sends,
/// unshields, and revenue splits.
///
/// ## The tree lives in the circuits, not in Solidity
///
/// The pool holds a depth-20 Poseidon2 Merkle root, but it never hashes
/// Poseidon2. Every entrypoint takes a proof that already did the work: the
/// prover supplies the sibling path, and the circuit walks it twice — once with
/// an empty leaf, recovering the root the pool already holds, and once with the
/// new commitment, producing the next one. The contract only has to check that
/// the before-root the proof claims is the root it actually stores.
///
/// That check is what makes the supplied path honest. A fabricated path reaches
/// a fabricated before-root, which cannot match storage, so there is no way to
/// hand back a root for a tree of one's own design. The alternative — a
/// hand-rolled Poseidon2 in Solidity — would cost roughly 20 hashes per inserted
/// leaf and put the pool's most security-critical arithmetic in the least
/// verified place. This costs about 12k extra constraints and nothing on chain.
///
/// The tradeoff is that spends serialize: the root and leaf index move with
/// every transaction, so two proofs built against the same root race, and the
/// loser reverts and reproves. With the pool this size that is invisible; the
/// fix when it stops being invisible is batching, not a different tree.
///
/// ## What the chain learns
///
/// A deposit is public by nature — token and value are calldata, and msg.value
/// or the ERC-20 Transfer would expose the amount whatever the log said. A spend
/// publishes two nullifiers, two opaque commitments, and a public leg that is
/// zero unless value is actually leaving. Amounts, assets and owners of the
/// private legs never appear.
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

    /// Roots kept spendable. An input note is proven against any of these, so a
    /// spend built a few blocks ago does not go stale because someone else
    /// deposited in the meantime. Outputs always append to the newest root.
    uint32 public constant ROOT_HISTORY = 32;

    /// Root of the empty depth-20 tree: ZEROS[20] in cli/src/shielded/tree.ts,
    /// pinned by a test in circuits/notes.
    bytes32 public constant EMPTY_ROOT =
        0x1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755;

    /// A published note ciphertext is fixed-width. A variable length would leak
    /// the way an unpadded payload once did — a wider blob for a larger note
    /// (see the padding note in cli/src/shielded/crypto.ts) — so every one is
    /// exactly these bytes, concatenated:
    ///   eph(33) + iv(12) + ct(96) + tag(16) + viewTag(1) = 158
    /// The pool never looks inside; the width is all it checks.
    uint256 public constant NOTE_CIPHER_LEN = 158;

    IVerifier public immutable shieldVerifier;
    IVerifier public immutable transferVerifier;

    bytes32 public root;
    uint32 public nextLeafIndex;

    /// Ring buffer plus a lookup map: the map answers in O(1), the ring says
    /// which entry to drop so history stays bounded instead of growing a slot
    /// per transaction forever.
    bytes32[32] internal rootRing;
    uint32 internal rootCursor;
    mapping(bytes32 => bool) public knownRoot;

    mapping(bytes32 => bool) public committed;
    mapping(bytes32 => bool) public nullifierSpent;

    /// Only what a client needs to rebuild the tree. A deposit's token and value
    /// are deliberately absent — they are already public on the deposit path, so
    /// repeating them here bought nothing and left a permanently indexed record
    /// beside the commitment for a later spend to be joined against.
    event NoteCommitted(bytes32 indexed commitment, uint32 leafIndex);
    /// The encrypted output note, relayed so its recipient can find it. Opaque
    /// to the pool — it never decrypts, it only carries the bytes to whoever
    /// holds the view key. Paired with its commitment by leaf index.
    event NoteCipher(uint32 leafIndex, bytes ciphertext);
    event Nullified(bytes32 indexed nullifier);

    error DuplicateCommitment();
    error TreeFull();
    error ZeroValue();
    error NotAField();
    error WrongDeposit();
    error InvalidProof();
    error TransferFailed();
    error UnknownRoot();
    error AlreadySpent();
    error RepeatedNullifier();
    error NoRecipient();
    error BadCipherLength();

    constructor(IVerifier _shieldVerifier, IVerifier _transferVerifier) {
        shieldVerifier = _shieldVerifier;
        transferVerifier = _transferVerifier;
        root = EMPTY_ROOT;
        _rememberRoot(EMPTY_ROOT);
    }

    /// Deposit `value` of `token` under a note commitment, appending it at
    /// `nextLeafIndex` and advancing the root to `newRoot`.
    function shield(
        uint256 token,
        uint256 value,
        bytes32 commitment,
        bytes32 newRoot,
        bytes calldata ciphertext,
        bytes calldata proof
    ) external payable {
        if (value == 0) revert ZeroValue();
        if (ciphertext.length != NOTE_CIPHER_LEN) revert BadCipherLength();
        if (value >= FR || uint256(commitment) >= FR || uint256(newRoot) >= FR) revert NotAField();
        // Non-native token ids are ERC-20 addresses; anything wider would
        // silently truncate in the uint160 cast below while the proof commits
        // to the full field element.
        if (token > type(uint160).max) revert NotAField();
        if (committed[commitment]) revert DuplicateCommitment();
        if (nextLeafIndex >= MAX_LEAVES) revert TreeFull();

        // Effects before the proof and the funds pull: the commitment can never
        // be replayed, even through a reentrant ERC-20.
        committed[commitment] = true;
        uint32 leafIndex = nextLeafIndex++;
        bytes32 oldRoot = root;
        _advanceRoot(newRoot);

        bytes32[] memory publicInputs = new bytes32[](6);
        publicInputs[0] = bytes32(token);
        publicInputs[1] = bytes32(value);
        publicInputs[2] = commitment;
        publicInputs[3] = oldRoot;
        publicInputs[4] = newRoot;
        publicInputs[5] = bytes32(uint256(leafIndex));
        if (!shieldVerifier.verify(proof, publicInputs)) revert InvalidProof();

        if (token == 0) {
            if (msg.value != value) revert WrongDeposit();
        } else {
            if (msg.value != 0) revert WrongDeposit();
            if (!IERC20(address(uint160(token))).transferFrom(msg.sender, address(this), value)) {
                revert TransferFailed();
            }
        }

        emit NoteCommitted(commitment, leafIndex);
        emit NoteCipher(leafIndex, ciphertext);
    }

    /// A join-split. `membershipRoot` is any remembered root the input notes sit
    /// under; the two output commitments append to the current root.
    ///
    /// `value` and `fee` are the only amounts that surface. Both zero means
    /// nothing leaves the pool and `token`, `recipient` and `relayer` are
    /// ignored — the circuit leaves them unbound in that case, so they carry no
    /// information either.
    struct Spend {
        bytes32 membershipRoot;
        bytes32[2] nullifiers;
        bytes32[2] commitments;
        bytes32 newRoot;
        uint256 token;
        uint256 value;
        uint256 fee;
        address recipient;
        address relayer;
    }

    function spend(Spend calldata s, bytes[2] calldata ciphertexts, bytes calldata proof) external {
        if (!knownRoot[s.membershipRoot]) revert UnknownRoot();
        if (s.nullifiers[0] == s.nullifiers[1]) revert RepeatedNullifier();
        if (nullifierSpent[s.nullifiers[0]] || nullifierSpent[s.nullifiers[1]]) revert AlreadySpent();
        if (s.commitments[0] == s.commitments[1]) revert DuplicateCommitment();
        if (committed[s.commitments[0]] || committed[s.commitments[1]]) revert DuplicateCommitment();
        if (nextLeafIndex + 2 > MAX_LEAVES) revert TreeFull();
        if (s.token > type(uint160).max) revert NotAField();
        if (s.value >= FR || s.fee >= FR || uint256(s.newRoot) >= FR) revert NotAField();
        if (uint256(s.commitments[0]) >= FR || uint256(s.commitments[1]) >= FR) revert NotAField();
        if (uint256(s.nullifiers[0]) >= FR || uint256(s.nullifiers[1]) >= FR) revert NotAField();
        // A payout with nowhere to go would burn shielded value that the proof
        // has already accounted for as spent.
        if (s.value != 0 && s.recipient == address(0)) revert NoRecipient();
        if (s.fee != 0 && s.relayer == address(0)) revert NoRecipient();
        if (ciphertexts[0].length != NOTE_CIPHER_LEN || ciphertexts[1].length != NOTE_CIPHER_LEN) {
            revert BadCipherLength();
        }

        uint32 insertIndex = nextLeafIndex;
        bytes32 oldRoot = root;

        // Every effect lands before the verifier call and long before any
        // payout, so a reentrant token cannot spend these nullifiers twice.
        nullifierSpent[s.nullifiers[0]] = true;
        nullifierSpent[s.nullifiers[1]] = true;
        committed[s.commitments[0]] = true;
        committed[s.commitments[1]] = true;
        nextLeafIndex = insertIndex + 2;
        _advanceRoot(s.newRoot);

        bytes32[] memory publicInputs = new bytes32[](13);
        publicInputs[0] = s.membershipRoot;
        publicInputs[1] = s.nullifiers[0];
        publicInputs[2] = s.nullifiers[1];
        publicInputs[3] = s.commitments[0];
        publicInputs[4] = s.commitments[1];
        publicInputs[5] = oldRoot;
        publicInputs[6] = s.newRoot;
        publicInputs[7] = bytes32(uint256(insertIndex));
        publicInputs[8] = bytes32(s.token);
        publicInputs[9] = bytes32(s.value);
        publicInputs[10] = bytes32(s.fee);
        publicInputs[11] = bytes32(uint256(uint160(s.recipient)));
        publicInputs[12] = bytes32(uint256(uint160(s.relayer)));
        if (!transferVerifier.verify(proof, publicInputs)) revert InvalidProof();

        emit Nullified(s.nullifiers[0]);
        emit Nullified(s.nullifiers[1]);
        emit NoteCommitted(s.commitments[0], insertIndex);
        emit NoteCipher(insertIndex, ciphertexts[0]);
        emit NoteCommitted(s.commitments[1], insertIndex + 1);
        emit NoteCipher(insertIndex + 1, ciphertexts[1]);

        if (s.value != 0) _payOut(s.token, s.recipient, s.value);
        if (s.fee != 0) _payOut(s.token, s.relayer, s.fee);
    }

    function _payOut(uint256 token, address to, uint256 amount) internal {
        if (token == 0) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(address(uint160(token))).transfer(to, amount)) revert TransferFailed();
        }
    }

    function _advanceRoot(bytes32 newRoot) internal {
        root = newRoot;
        _rememberRoot(newRoot);
    }

    function _rememberRoot(bytes32 r) internal {
        bytes32 evicted = rootRing[rootCursor];
        if (evicted != bytes32(0)) knownRoot[evicted] = false;
        rootRing[rootCursor] = r;
        knownRoot[r] = true;
        rootCursor = (rootCursor + 1) % ROOT_HISTORY;
    }
}
