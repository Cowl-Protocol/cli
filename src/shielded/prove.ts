// Proof generation for the shielded pool, entirely in-process.
//
// Both halves run as WebAssembly inside Node, so `cowl shield` works off a plain
// `npm i -g` with no Noir toolchain on the machine:
//   noir_js  executes the circuit and produces the witness (what `nargo execute` does)
//   bb.js    turns that witness into an UltraHonk proof (what `bb prove` does)
//
// Three things here are load-bearing and will silently produce proofs the chain
// rejects if changed:
//
//   1. `verifierTarget: "evm"` — the ZK UltraHonk variant with a keccak transcript,
//      178 fields / 5696 bytes, which is what the deployed verifier expects. The
//      older `{ keccak: true }` option is NOT the same: it disables ZK and yields a
//      155-field proof that reverts on chain with ProofLengthWrongWithLogN.
//   2. `backend: BackendType.Wasm`, pinned deliberately. Left to itself bb.js
//      prefers a native `bb` binary off the PATH and only falls back to WASM, so a
//      developer with an unrelated bb installed would prove through different code
//      than everyone else — and a version-skewed bb produces proofs this pool's
//      verifier refuses. Same path for every user is worth more than the speedup.
//   3. The pinned versions in package.json. @aztec/bb.js must match the `bb` that
//      wrote the verifying key inside ShieldVerifier.sol, and @noir-lang/noir_js
//      must match the `nargo` that compiled SHIELD_CIRCUIT.
// Deliberately NOT static imports: esbuild hoists a bundled module's external
// imports to the top of dist/cli.mjs, which would make every command — including
// `cowl --version` — pay to load the proving stack. Dynamic import of an external
// survives bundling untouched, so only a real proof loads the WASM.
import { SHIELD_CIRCUIT, TRANSFER_CIRCUIT } from "./circuit.js";
import { fieldToHex, randomField } from "./field.js";
import { commitment, nullifier, type Note } from "./note.js";
import { appendProof, computeRoot, merkleProof } from "./tree.js";

/**
 * Structured reference string to load, in G1 points.
 *
 * Barretenberg defaults to 524288, which downloads a 53MB CRS into ~/.bb-crs the
 * first time anyone shields. The shield circuit is ~3.3k gates and the join-split
 * ~13k, so that is far more than either needs. 131072 is the floor the WASM
 * backend accepts — it rejects anything that is not a multiple of it — and cuts
 * the one-time download to 17MB with no change in proving time. Raise it (in
 * multiples of 131072) if a future circuit outgrows it; the symptom is a failure
 * inside srsInitSrs, not a bad proof. circuits/fixtures.mjs pins the same value.
 */
const SRS_SIZE = 131072;

export type ShieldProof = {
  /** UltraHonk proof bytes, passed straight to ShieldedPool.shield(). */
  proof: `0x${string}`;
  /** Public inputs in the order shield/src/main.nr declares them. */
  publicInputs: readonly `0x${string}`[];
};

/**
 * Where the note is about to land in the tree. The contract holds a root but
 * never hashes Poseidon2 — the proof does that work, so the deposit has to carry
 * the sibling path at the slot it is appending to, and the root that results.
 *
 * `oldRoot` must be the pool's root at the moment the transaction executes. If
 * another deposit lands first the root has moved, the proof no longer matches,
 * and the transaction reverts — sync and reprove.
 */
export type Insertion = import("./tree.js").Append;

/**
 * Prove that `commitment` is a well-formed Poseidon2 commitment to this note,
 * and that appending it at `at.leafIndex` carries the tree from `at.oldRoot` to
 * `at.newRoot`. `mpk` and `blinding` stay private; token and value are public
 * because the contract checks them against the actual transfer.
 */
export async function proveShield(
  note: Note,
  commitment: bigint,
  at: Insertion,
): Promise<ShieldProof> {
  const [{ UltraHonkBackend, Barretenberg, BackendType }, { Noir }] = await Promise.all([
    import("@aztec/bb.js"),
    import("@noir-lang/noir_js"),
  ]);
  const noir = new Noir(SHIELD_CIRCUIT as never);
  const { witness } = await noir.execute({
    mpk: fieldToHex(note.mpk),
    blinding: fieldToHex(note.blinding),
    insert_path: at.pathElements.map(fieldToHex),
    insert_right: at.right,
    token: fieldToHex(note.token),
    value: fieldToHex(note.value),
    commitment: fieldToHex(commitment),
    old_root: fieldToHex(at.oldRoot),
    new_root: fieldToHex(at.newRoot),
    leaf_index: fieldToHex(BigInt(at.leafIndex)),
  });

  const api = await Barretenberg.new({
    backend: BackendType.Wasm,
    threads: proverThreads(),
    srsSize: SRS_SIZE,
  });
  try {
    const backend = new UltraHonkBackend(SHIELD_CIRCUIT.bytecode, api);
    const { proof, publicInputs } = await quietly(() =>
      backend.generateProof(witness, { verifierTarget: "evm" }),
    );
    if (publicInputs.length !== 6) {
      throw new Error(`expected 6 public inputs, got ${publicInputs.length}`);
    }
    return {
      proof: `0x${Buffer.from(proof).toString("hex")}`,
      publicInputs: publicInputs.map(pad32),
    };
  } finally {
    await api.destroy();
  }
}

/** One note being spent, already sitting in the tree at `leafIndex`. */
export type SpendInput = { value: bigint; blinding: bigint; leafIndex: number };
/** One note being created. `mpk` is its owner — the recipient's for a payment, yours for change. */
export type SpendOutput = { mpk: bigint; value: bigint; blinding: bigint };

export type SpendPlan = {
  sk: bigint;
  nk: bigint;
  /** The asset the notes hold. Private — it surfaces only through publicToken, when value leaves. */
  token: bigint;
  /** One or two notes to spend. A single-note spend is padded with a zero-value dummy. */
  inputs: SpendInput[];
  /** Exactly two outputs, in order. Either may be a zero-value filler. */
  outputs: [SpendOutput, SpendOutput];
  /** Every commitment currently in the tree; membership and the append paths derive from it. */
  leaves: bigint[];
  /** The public leg. All zero (value + fee) means nothing leaves and this is a pure private spend. */
  publicToken: bigint;
  publicValue: bigint;
  fee: bigint;
  /** Payout targets as address-fields; 0 when that leg is unused. */
  recipient: bigint;
  relayer: bigint;
  /** The chain this spend is for. Bound into the proof and checked against
   * block.chainid on chain, so a proof cannot be replayed on another instance. */
  chainId: bigint;
};

/** The subset of a proof that ShieldedPool.spend's Spend struct consumes. */
export type SpendStruct = {
  membershipRoot: `0x${string}`;
  nullifiers: readonly [`0x${string}`, `0x${string}`];
  commitments: readonly [`0x${string}`, `0x${string}`];
  newRoot: `0x${string}`;
  token: bigint;
  value: bigint;
  fee: bigint;
  recipient: bigint;
  relayer: bigint;
};

export type SpendProof = {
  /** UltraHonk proof bytes, passed straight to ShieldedPool.spend(). */
  proof: `0x${string}`;
  /** All 14 public inputs, in the order spend() rebuilds them — kept for cross-checks. */
  publicInputs: readonly `0x${string}`[];
  /** Everything spend()'s Spend struct needs, already derived from the same witness. */
  spend: SpendStruct;
  /** Leaf index the first output lands at; the second is insertIndex + 1. */
  insertIndex: number;
};

/** fieldToHex is 0x-prefixed and 32 bytes by construction; tell the type system so. */
const hx = (x: bigint): `0x${string}` => fieldToHex(x) as `0x${string}`;

/**
 * Prove a join-split: up to two input notes are nullified and two outputs are
 * appended, with an optional public leg leaving the pool. The witness mirrors
 * circuits/fixtures.mjs exactly — the fixture that ShieldedPool.t.sol verifies —
 * so a drift here fails a contract test rather than a live spend.
 *
 * `plan.leaves` must be the tree as the chain holds it right now: membership is
 * proven against it and the outputs append to it, so sync immediately before
 * proving and treat a revert as "someone spent first" — reprove against the new root.
 */
export async function proveTransfer(plan: SpendPlan): Promise<SpendProof> {
  if (plan.inputs.length < 1 || plan.inputs.length > 2) {
    throw new Error(`A join-split takes one or two input notes, got ${plan.inputs.length}.`);
  }
  // The tree the inputs sit under is also the root the outputs append to.
  const membershipRoot = computeRoot(plan.leaves);
  const insertIndex = plan.leaves.length;

  const inValue: bigint[] = [];
  const inBlinding: bigint[] = [];
  const inLeafIndex: bigint[] = [];
  const inPath: bigint[][] = [];
  const inRight: boolean[][] = [];
  const nullifiers: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    const real = plan.inputs[i];
    if (real) {
      const mp = merkleProof(plan.leaves, real.leafIndex);
      inValue.push(real.value);
      inBlinding.push(real.blinding);
      inLeafIndex.push(BigInt(real.leafIndex));
      inPath.push(mp.pathElements);
      inRight.push(mp.pathIndices.map((b) => b === 1));
      nullifiers.push(nullifier(plan.nk, real.leafIndex));
    } else {
      // A zero-value dummy. The circuit waives its membership and leaf-index checks,
      // so the index only has to land outside the 0..2^20 real range — a random field
      // does — and be fresh each spend, or a fixed dummy nullifier would collide with
      // an earlier spend's and revert AlreadySpent. Its path only has to be well-formed.
      const dummyIndex = randomField();
      const shape = merkleProof(plan.leaves, plan.inputs[0]!.leafIndex);
      inValue.push(0n);
      inBlinding.push(randomField());
      inLeafIndex.push(dummyIndex);
      inPath.push(shape.pathElements);
      inRight.push(shape.pathIndices.map((b) => b === 1));
      nullifiers.push(nullifier(plan.nk, dummyIndex));
    }
  }

  const outCommitments = plan.outputs.map((o) =>
    commitment({ mpk: o.mpk, token: plan.token, value: o.value, blinding: o.blinding }),
  );
  // Chained appends: the second output lands on the tree the first one produced.
  const append1 = appendProof(plan.leaves, outCommitments[0]!);
  const append2 = appendProof([...plan.leaves, outCommitments[0]!], outCommitments[1]!);
  const newRoot = append2.newRoot;

  const input = {
    sk: fieldToHex(plan.sk),
    token: fieldToHex(plan.token),
    in_value: inValue.map(fieldToHex),
    in_blinding: inBlinding.map(fieldToHex),
    in_leaf_index: inLeafIndex.map(fieldToHex),
    in_path: inPath.map((p) => p.map(fieldToHex)),
    in_right: inRight,
    out_mpk: plan.outputs.map((o) => fieldToHex(o.mpk)),
    out_value: plan.outputs.map((o) => fieldToHex(o.value)),
    out_blinding: plan.outputs.map((o) => fieldToHex(o.blinding)),
    out_path: [append1.pathElements.map(fieldToHex), append2.pathElements.map(fieldToHex)],
    out_right: [append1.right, append2.right],
    membership_root: fieldToHex(membershipRoot),
    nullifiers: nullifiers.map(fieldToHex),
    out_commitments: outCommitments.map(fieldToHex),
    old_root: fieldToHex(membershipRoot),
    new_root: fieldToHex(newRoot),
    insert_index: fieldToHex(BigInt(insertIndex)),
    public_token: fieldToHex(plan.publicToken),
    public_value: fieldToHex(plan.publicValue),
    fee: fieldToHex(plan.fee),
    recipient: fieldToHex(plan.recipient),
    relayer: fieldToHex(plan.relayer),
    chain_id: fieldToHex(plan.chainId),
  };

  const [{ UltraHonkBackend, Barretenberg, BackendType }, { Noir }] = await Promise.all([
    import("@aztec/bb.js"),
    import("@noir-lang/noir_js"),
  ]);
  const noir = new Noir(TRANSFER_CIRCUIT as never);
  const { witness } = await noir.execute(input);

  const api = await Barretenberg.new({
    backend: BackendType.Wasm,
    threads: proverThreads(),
    srsSize: SRS_SIZE,
  });
  try {
    const backend = new UltraHonkBackend(TRANSFER_CIRCUIT.bytecode, api);
    const { proof, publicInputs } = await quietly(() =>
      backend.generateProof(witness, { verifierTarget: "evm" }),
    );
    if (publicInputs.length !== 14) {
      throw new Error(`expected 14 public inputs, got ${publicInputs.length}`);
    }
    return {
      proof: `0x${Buffer.from(proof).toString("hex")}`,
      publicInputs: publicInputs.map(pad32),
      spend: {
        membershipRoot: hx(membershipRoot),
        nullifiers: [hx(nullifiers[0]!), hx(nullifiers[1]!)],
        commitments: [hx(outCommitments[0]!), hx(outCommitments[1]!)],
        newRoot: hx(newRoot),
        token: plan.publicToken,
        value: plan.publicValue,
        fee: plan.fee,
        recipient: plan.recipient,
        relayer: plan.relayer,
      },
      insertIndex,
    };
  } finally {
    await api.destroy();
  }
}

/**
 * Run `fn` with console.log muted.
 *
 * bb.js announces "Generated proof for circuit with N public inputs…" on stdout
 * from inside generateProof. There is no option to turn it off, and it lands in
 * the middle of the spinner line. Errors still surface — this only takes stdout
 * chatter, and only for the duration of the call.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** bb.js returns field elements already 0x-prefixed; make the width explicit anyway. */
function pad32(hex: string): `0x${string}` {
  const raw = hex.replace(/^0x/, "");
  if (raw.length > 64) throw new Error(`public input wider than 32 bytes: ${hex}`);
  return `0x${raw.padStart(64, "0")}`;
}

/**
 * Barretenberg spawns this many workers. Proving the shield circuit takes a few
 * hundred milliseconds, so this is about not stalling a laptop rather than speed.
 */
function proverThreads(): number {
  const env = Number(process.env.COWL_PROVER_THREADS);
  if (Number.isInteger(env) && env > 0) return env;
  return 4;
}
