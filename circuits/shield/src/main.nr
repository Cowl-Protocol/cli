// The shield circuit — a deposit into the pool. No input notes, no nullifier:
// it proves two things and nothing else.
//
//   1. the commitment is well-formed over the token and value being deposited
//   2. appending it to the tree the chain holds today yields `new_root`
//
// The second half is what lets the contract keep a root without ever hashing
// Poseidon2 in Solidity. The prover supplies the sibling path; the circuit
// re-walks it once with an empty leaf to recover the root the chain already has,
// and once with the commitment to produce the next one. Because the before-root
// is checked against the contract's current root, the siblings cannot be
// invented — a made-up path reaches a made-up before-root and the tx reverts.
//
// token and value are public because a deposit is visible by nature: the
// contract checks them against the actual transfer. Privacy starts at the
// commitment: mpk and blinding stay private, so once the note is in the tree
// nothing links a later spend back to this deposit.
use notes::{commit, insert, TREE_DEPTH};

fn main(
    // private
    mpk: Field,
    blinding: Field,
    insert_path: [Field; TREE_DEPTH],
    insert_right: [bool; TREE_DEPTH],
    // public
    token: pub Field,
    value: pub Field,
    commitment: pub Field,
    old_root: pub Field,
    new_root: pub Field,
    leaf_index: pub Field,
) {
    assert_eq(commit(mpk, token, value, blinding), commitment);

    let (before, after, index) = insert(commitment, insert_path, insert_right);
    assert(before == old_root, "insertion path does not match the current tree");
    assert(after == new_root, "new root does not follow from the insertion");
    assert(index == leaf_index, "leaf index contradicts the insertion path");
}

#[test]
fn deposit_into_an_empty_tree() {
    let mpk = 1;
    let token = 2;
    let value = 3;
    let blinding = 4;
    let c = commit(mpk, token, value, blinding);
    // Pinned to the JS side: poseidon2Hash([1, 2, 3, 4]) from
    // circuits/poseidon-parity/js-vectors.mjs.
    assert_eq(c, 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9);

    let path = notes::zeros_path();
    let right = [false; TREE_DEPTH];
    let (before, after, _) = insert(c, path, right);
    main(mpk, blinding, path, right, token, value, c, before, after, 0);
}

#[test(should_fail)]
fn wrong_blinding_fails() {
    let path = notes::zeros_path();
    let right = [false; TREE_DEPTH];
    let c = commit(1, 2, 3, 4);
    let (before, after, _) = insert(c, path, right);
    main(1, 5, path, right, 2, 3, c, before, after, 0);
}

#[test(should_fail_with = "insertion path does not match the current tree")]
fn cannot_insert_against_a_tree_the_chain_does_not_have() {
    let path = notes::zeros_path();
    let right = [false; TREE_DEPTH];
    let c = commit(1, 2, 3, 4);
    let (_, after, _) = insert(c, path, right);
    main(1, 4, path, right, 2, 3, c, 0xdead, after, 0);
}

#[test(should_fail_with = "new root does not follow from the insertion")]
fn cannot_claim_an_unrelated_new_root() {
    let path = notes::zeros_path();
    let right = [false; TREE_DEPTH];
    let c = commit(1, 2, 3, 4);
    let (before, _, _) = insert(c, path, right);
    main(1, 4, path, right, 2, 3, c, before, 0xbeef, 0);
}
