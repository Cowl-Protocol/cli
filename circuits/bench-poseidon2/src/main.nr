// Cost probe: the same commitment + depth-20 Merkle path workload as
// bench_circomlib, but hashed with Barretenberg-native Poseidon2.
use poseidon::poseidon2::Poseidon2;

global DEPTH: u32 = 20;

fn main(
    mpk: Field,
    token: Field,
    value: Field,
    blinding: Field,
    path: [Field; DEPTH],
    idx: [bool; DEPTH],
    root: pub Field,
) {
    let commitment = Poseidon2::hash([mpk, token, value, blinding], 4);
    let mut node = commitment;
    for i in 0..DEPTH {
        let (l, r) = if idx[i] { (path[i], node) } else { (node, path[i]) };
        node = Poseidon2::hash([l, r], 2);
    }
    assert_eq(node, root);
}
