// Cost probe: commitment + depth-20 Merkle path with circomlib-style Poseidon
// (the hash poseidon-lite already matches). Compare `nargo info` / `bb gates`
// against bench_poseidon2 — the workload is identical, only the hash differs.
use poseidon::poseidon::bn254;

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
    let commitment = bn254::hash_4([mpk, token, value, blinding]);
    let mut node = commitment;
    for i in 0..DEPTH {
        let (l, r) = if idx[i] { (path[i], node) } else { (node, path[i]) };
        node = bn254::hash_2([l, r]);
    }
    assert_eq(node, root);
}
