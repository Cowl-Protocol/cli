// The note format and the tree, shared by every circuit in the pool.
//
// Both `shield` and `transfer` insert leaves and both hash notes, so the rules
// live in one place: a commitment that means one thing to the deposit circuit
// and another to the spend circuit is how a pool gets drained.
//
// Parity with the client is pinned in circuits/poseidon-parity and mirrored in:
//   cli/src/shielded/note.ts   commitment, nullifier
//   cli/src/shielded/keys.ts   nk, mpk
//   cli/src/shielded/tree.ts   depth, zeros, path walk
use poseidon::poseidon2::Poseidon2;

pub global TREE_DEPTH: u32 = 20;

/// Amount width. Every value, fee and public leg is range-checked to this, so
/// the largest sum any circuit forms stays far below FR (~2^254) and no
/// addition can wrap the field to fake conservation. Widening this without
/// redoing that arithmetic per circuit reopens the hole.
pub global VALUE_BITS: u32 = 128;

/// Domain tags. mpk-derivation and nullification are otherwise both two-field
/// Poseidon2 hashes — the same shape as a Merkle node — so a digest computed in
/// one role could be a valid digest in another. Prepending a distinct constant
/// gives each a unique (tag, arity) and removes that overlap. The Merkle node
/// hash keeps the plain two-field form on purpose, so the empty-tree root is
/// unchanged; nk (one field) and the commitment (four fields) already sit at
/// unique arities and need no tag. Values are ASCII "cowl:mpk" / "cowl:nul" and
/// are mirrored in cli/src/shielded/field.ts.
pub global DOMAIN_MPK: Field = 0x636f776c3a6d706b;
pub global DOMAIN_NULLIFIER: Field = 0x636f776c3a6e756c;

/// nk = Poseidon2(sk), mpk = Poseidon2(DOMAIN_MPK, sk, nk). Derived rather than
/// passed in, so holding sk is the only way to spend a note owned by mpk.
pub fn derive_keys(sk: Field) -> (Field, Field) {
    let nk = Poseidon2::hash([sk], 1);
    let mpk = Poseidon2::hash([DOMAIN_MPK, sk, nk], 3);
    (nk, mpk)
}

pub fn commit(mpk: Field, token: Field, value: Field, blinding: Field) -> Field {
    Poseidon2::hash([mpk, token, value, blinding], 4)
}

pub fn nullify(nk: Field, leaf_index: Field) -> Field {
    Poseidon2::hash([DOMAIN_NULLIFIER, nk, leaf_index], 3)
}

/// Hash `leaf` up through `path` and return the root it reaches, plus the leaf
/// index the direction bits spell out. `right[d]` true means this node is the
/// right child at that level.
///
/// Returning the index is what ties a nullifier to a proven position: the caller
/// checks it against the index it nullifies, so membership cannot be proven at
/// one slot while a different slot is spent.
pub fn walk(
    leaf: Field,
    path: [Field; TREE_DEPTH],
    right: [bool; TREE_DEPTH],
) -> (Field, Field) {
    let mut node = leaf;
    let mut index: Field = 0;
    let mut place: Field = 1;
    for d in 0..TREE_DEPTH {
        let sibling = path[d];
        let l = if right[d] { sibling } else { node };
        let r = if right[d] { node } else { sibling };
        node = Poseidon2::hash([l, r], 2);
        index += (right[d] as Field) * place;
        place *= 2;
    }
    (node, index)
}

/// Append `leaf` at the position `path` describes, returning
/// `(root_before, root_after, index)`.
///
/// The before-root is the same walk with an empty leaf. That is the load-bearing
/// half: it pins the siblings to the tree the chain currently has. Computing
/// only the after-root would let a prover invent a path and hand back a root for
/// a tree of their own design, notes and all.
///
/// An empty leaf is 0, matching ZEROS[0] in cli/src/shielded/tree.ts.
pub fn insert(
    leaf: Field,
    path: [Field; TREE_DEPTH],
    right: [bool; TREE_DEPTH],
) -> (Field, Field, Field) {
    let (root_before, index) = walk(0, path, right);
    let (root_after, _) = walk(leaf, path, right);
    (root_before, root_after, index)
}

/// Root of the empty depth-20 tree — what the pool starts at.
pub fn empty_root() -> Field {
    let mut node: Field = 0;
    for _ in 0..TREE_DEPTH {
        node = Poseidon2::hash([node, node], 2);
    }
    node
}

#[test]
fn empty_root_matches_the_client_and_the_contract() {
    // Pinned three ways: ZEROS[DEPTH] in cli/src/shielded/tree.ts, and
    // EMPTY_ROOT in cli/contracts/src/ShieldedPool.sol. A pool that starts at a
    // different root than its clients think can never accept a proof.
    assert_eq(
        empty_root(),
        0x1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755,
    );
}

#[test]
fn insert_into_empty_tree_starts_from_empty_root() {
    let path = zeros_path();
    let (before, after, index) = insert(42, path, [false; TREE_DEPTH]);
    assert_eq(before, empty_root());
    assert_eq(index, 0);
    assert(after != before);
}

#[test]
fn index_follows_the_direction_bits() {
    let mut right = [false; TREE_DEPTH];
    right[0] = true;
    right[3] = true;
    let (_, index) = walk(42, zeros_path(), right);
    assert_eq(index, 1 + 8);
}

/// Sibling path for leaf 0 of an otherwise empty tree: every sibling is the
/// empty subtree at that level.
pub fn zeros_path() -> [Field; TREE_DEPTH] {
    let mut path: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    for d in 1..TREE_DEPTH {
        path[d] = Poseidon2::hash([path[d - 1], path[d - 1]], 2);
    }
    path
}
