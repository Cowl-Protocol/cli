// The shield circuit — a deposit into the pool. The simplest of the four:
// no input notes, no Merkle proof, no nullifier. It proves one thing only:
// the commitment the contract is about to insert is well-formed over the
// token and value being deposited.
//
//   commitment = Poseidon2(mpk, token, value, blinding)      (cli/src/shielded/note.ts)
//
// token and value are public because a deposit is visible by nature — the
// contract checks them against the actual transfer. Privacy starts at the
// commitment: mpk and blinding stay private, so once the note is in the tree
// nothing links a later spend back to this deposit.
use poseidon::poseidon2::Poseidon2;

fn main(
    // private
    mpk: Field,
    blinding: Field,
    // public
    token: pub Field,
    value: pub Field,
    commitment: pub Field,
) {
    assert_eq(Poseidon2::hash([mpk, token, value, blinding], 4), commitment);
}

#[test]
fn test_commitment_shape() {
    // Pinned to the JS side: poseidon2Hash([1, 2, 3, 4]) from
    // circuits/poseidon-parity/js-vectors.mjs.
    main(
        1,
        4,
        2,
        3,
        0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9,
    );
}

#[test(should_fail)]
fn test_wrong_blinding_fails() {
    main(
        1,
        5,
        2,
        3,
        0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9,
    );
}
