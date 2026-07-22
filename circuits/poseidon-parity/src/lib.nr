// Parity gate between the CLI's JS hashing and this toolchain. The expected
// constants are the output of circuits/poseidon-parity/js-vectors.mjs
// (@zkpassport/poseidon2 0.6.2, BN254 Fr).
//
//   nargo test
//
// If test_poseidon2_parity passes, every commitment and nullifier the CLI
// produces is provable by a circuit that hashes with poseidon::poseidon2.
// If it ever fails after a toolchain or dependency bump, STOP: the JS pool
// and the circuits have diverged and nothing proven is spendable.
//
// test_circomlib_parity records a settled fact: poseidon-lite (the pool's
// original hash) matches poseidon::bn254 exactly. The pool moved to Poseidon2
// for the ~53x constraint saving (see ../bench-*), not because parity failed.

use poseidon::poseidon::bn254;
use poseidon::poseidon2::Poseidon2;

#[test]
fn test_poseidon2_parity() {
    // poseidon2Hash([1])
    assert_eq(
        Poseidon2::hash([1], 1),
        0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373,
    );
    // poseidon2Hash([1, 2]) — the Merkle node shape: Poseidon2(left, right)
    assert_eq(
        Poseidon2::hash([1, 2], 2),
        0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383,
    );
    // poseidon2Hash([1, 2, 3])
    assert_eq(
        Poseidon2::hash([1, 2, 3], 3),
        0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8,
    );
    // poseidon2Hash([1, 2, 3, 4]) — the commitment shape: Poseidon2(mpk, token, value, blinding)
    assert_eq(
        Poseidon2::hash([1, 2, 3, 4], 4),
        0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9,
    );
    // poseidon2Hash([0, 0]) — the empty Merkle leaf pair; depth-20 zero hashes chain off it
    assert_eq(
        Poseidon2::hash([0, 0], 2),
        0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1,
    );
}

#[test]
fn test_circomlib_parity() {
    // poseidon-lite 0.3.0 vectors — kept as a record that the circomlib path
    // was viable; the pool no longer hashes with these.
    assert_eq(
        bn254::hash_1([1]),
        0x29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133,
    );
    assert_eq(
        bn254::hash_2([1, 2]),
        0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a,
    );
    assert_eq(
        bn254::hash_3([1, 2, 3]),
        0x0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732,
    );
    assert_eq(
        bn254::hash_4([1, 2, 3, 4]),
        0x299c867db6c1fdd79dcefa40e4510b9837e60ebb1ce0663dbaa525df65250465,
    );
    assert_eq(
        bn254::hash_2([0, 0]),
        0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864,
    );
}
