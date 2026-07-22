// Reference Poseidon2 vectors from the JS side of the shielded pool.
// These are the exact numbers `cli/src/shielded/field.ts` produces, so
// anything the circuits hash has to reproduce them byte for byte — otherwise
// every commitment and nullifier the CLI writes is unprovable.
//
//   node circuits/poseidon-parity/js-vectors.mjs
//
// The Noir side asserts these same constants in poseidon-parity/src/lib.nr;
// `nargo test` there is the parity gate.
//
// History: the pool originally hashed with poseidon-lite (circomlib-style
// Poseidon). Parity with Noir's poseidon::bn254 was proven too, but Poseidon2
// costs ~53x fewer constraints under UltraHonk (see ../bench-*), so the pool
// switched before anything reached the chain.
import { poseidon2Hash } from "@zkpassport/poseidon2";

const hex = (x) => "0x" + x.toString(16).padStart(64, "0");

const vectors = [
  ["poseidon2Hash([1])", poseidon2Hash([1n])],
  ["poseidon2Hash([1, 2])", poseidon2Hash([1n, 2n])],
  ["poseidon2Hash([1, 2, 3])", poseidon2Hash([1n, 2n, 3n])],
  ["poseidon2Hash([1, 2, 3, 4])", poseidon2Hash([1n, 2n, 3n, 4n])],
  // The empty-subtree leaf. Depth-20 zero hashes all chain off this one.
  ["poseidon2Hash([0, 0])", poseidon2Hash([0n, 0n])],
];

for (const [label, value] of vectors) {
  console.log(label.padEnd(30), hex(value));
}
