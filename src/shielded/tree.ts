// Fixed-depth incremental Merkle tree over Poseidon — the accumulator of note
// commitments. A spend proves its commitment sits under a known root via a Merkle
// path, which is exactly the witness the Noir circuit will consume.
import { poseidon } from "./field.js";

export const DEPTH = 20; // ~1M notes

// Precomputed hashes of empty subtrees at each level.
const ZEROS: bigint[] = (() => {
  const z: bigint[] = [0n];
  for (let i = 1; i <= DEPTH; i++) z.push(poseidon([z[i - 1]!, z[i - 1]!]));
  return z;
})();

export function emptyRoot(): bigint {
  return ZEROS[DEPTH]!;
}

/** All node levels bottom-up: levels[0] = leaves, levels[DEPTH] = [root]. */
function levelsOf(leaves: bigint[]): bigint[][] {
  const levels: bigint[][] = [leaves.slice()];
  for (let d = 0; d < DEPTH; d++) {
    const cur = levels[d]!;
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i]!;
      const r = i + 1 < cur.length ? cur[i + 1]! : ZEROS[d]!;
      next.push(poseidon([l, r]));
    }
    levels.push(next);
  }
  return levels;
}

export function computeRoot(leaves: bigint[]): bigint {
  if (leaves.length === 0) return emptyRoot();
  return levelsOf(leaves)[DEPTH]![0]!;
}

export type MerkleProof = {
  root: bigint;
  leaf: bigint;
  pathElements: bigint[]; // sibling at each level
  pathIndices: number[]; // 0 = we are the left child, 1 = right
};

export function merkleProof(leaves: bigint[], index: number): MerkleProof {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const levels = levelsOf(leaves);
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let idx = index;
  for (let d = 0; d < DEPTH; d++) {
    const level = levels[d]!;
    const isRight = idx & 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    pathElements.push(sibIdx < level.length ? level[sibIdx]! : ZEROS[d]!);
    pathIndices.push(isRight);
    idx >>= 1;
  }
  return { root: levels[DEPTH]![0]!, leaf: leaves[index]!, pathElements, pathIndices };
}

/** Recompute a root from a leaf + path — the check the circuit enforces. */
export function verifyProof(p: MerkleProof): boolean {
  let node = p.leaf;
  for (let d = 0; d < DEPTH; d++) {
    node = p.pathIndices[d] ? poseidon([p.pathElements[d]!, node]) : poseidon([node, p.pathElements[d]!]);
  }
  return node === p.root;
}
