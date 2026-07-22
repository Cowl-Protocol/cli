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

export type Append = {
  pathElements: bigint[];
  /** True where the appended node is the right child at that level. */
  right: boolean[];
  oldRoot: bigint;
  newRoot: bigint;
  leafIndex: number;
};

/**
 * Witness for appending `leaf` after `leaves` — what a deposit or a spend hands
 * the circuit so the chain can move its root without hashing Poseidon2 itself.
 *
 * The path is read at the empty slot the leaf is about to occupy. That is the
 * point: walking the same siblings with an empty leaf reproduces the root the
 * pool holds right now, so an invented path reaches an unrecognised root and the
 * transaction reverts. An unwritten slot and an explicit zero leaf hash the same
 * (ZEROS[0] is 0), which is why one path serves both walks.
 */
export function appendProof(leaves: bigint[], leaf: bigint): Append {
  const leafIndex = leaves.length;
  const p = merkleProof([...leaves, 0n], leafIndex);
  return {
    pathElements: p.pathElements,
    right: p.pathIndices.map((b) => b === 1),
    oldRoot: p.root,
    newRoot: computeRoot([...leaves, leaf]),
    leafIndex,
  };
}

/** Recompute a root from a leaf + path — the check the circuit enforces. */
export function verifyProof(p: MerkleProof): boolean {
  let node = p.leaf;
  for (let d = 0; d < DEPTH; d++) {
    node = p.pathIndices[d] ? poseidon([p.pathElements[d]!, node]) : poseidon([node, p.pathElements[d]!]);
  }
  return node === p.root;
}
