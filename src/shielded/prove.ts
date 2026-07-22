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
import { SHIELD_CIRCUIT } from "./circuit.js";
import { fieldToHex } from "./field.js";
import type { Note } from "./note.js";

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
