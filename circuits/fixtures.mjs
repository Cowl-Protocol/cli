// Build the proof fixtures the Solidity tests verify, using the CLI's own note
// math — not a reimplementation of it.
//
//   node circuits/fixtures.mjs
//
// It bundles src/shielded/{keys,note,tree,field}.ts, builds a deposit and then a
// spend of that deposit on top of it, proves both with the same bb.js settings
// `cowl shield` uses, and writes each proof plus its public inputs under
// circuits/target/. contracts/test/ShieldedPool.t.sol reads them, so a drift
// between the client, the circuits and the contract fails a test instead of a
// mainnet transaction.
//
// Run it after any change to circuits/, then `nargo compile` and regenerate the
// verifiers — the fixtures are only valid for the exact circuit that made them.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, Barretenberg, BackendType } from "@aztec/bb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const TARGET = join(HERE, "target");
const SRS_SIZE = 131072; // must match SRS_SIZE in src/shielded/prove.ts

// A fixed key and fixed blindings: the fixtures have to be byte-identical run to
// run, or every regeneration would churn the contract tests.
const PRIVATE_KEY = "0x" + "11".repeat(32);
const DEPOSIT = 1000n;
const RECIPIENT = 0x00000000000000000000000000000000000b0b00n;
const RELAYER = 0x0000000000000000000000000000000000c0ffeen;

const client = await bundleClient();

// The CLI proves with the circuits embedded in src/shielded/circuit.ts, not
// with target/ — so a recompile that skipped `node circuits/embed.mjs` leaves
// the CLI proving against an old circuit while these fixtures pass against the
// new one. Catch that drift here, where every other parity break is caught.
for (const name of ["shield", "transfer"]) {
  const compiled = JSON.parse(readFileSync(join(TARGET, `${name}.json`), "utf8"));
  const embedded = name === "shield" ? client.SHIELD_CIRCUIT : client.TRANSFER_CIRCUIT;
  if (embedded.hash !== compiled.hash) {
    throw new Error(
      `${name}: src/shielded/circuit.ts embeds hash ${embedded.hash} but target/${name}.json is ${compiled.hash}. ` +
        `Run \`node circuits/embed.mjs\` and rebuild.`,
    );
  }
}

const { deriveShieldedKeys, commitment, nullifier, merkleProof, computeRoot, appendProof, fieldToHex } =
  client;

const keys = deriveShieldedKeys(PRIVATE_KEY);
const token = 0n; // native coin, so the pool takes the msg.value path

// ---------------------------------------------------------------- deposit ---

const deposited = { value: DEPOSIT, token, mpk: keys.mpk, blinding: 4n };
const c0 = commitment(deposited);
const depositAppend = appendProof([], c0);
const shieldInput = {
  mpk: fieldToHex(keys.mpk),
  blinding: fieldToHex(deposited.blinding),
  insert_path: depositAppend.pathElements.map(fieldToHex),
  insert_right: depositAppend.right,
  token: fieldToHex(token),
  value: fieldToHex(DEPOSIT),
  commitment: fieldToHex(c0),
  old_root: fieldToHex(depositAppend.oldRoot),
  new_root: fieldToHex(depositAppend.newRoot),
  leaf_index: fieldToHex(BigInt(depositAppend.leafIndex)),
};
await proveInto("shield", shieldInput, [
  fieldToHex(token),
  fieldToHex(DEPOSIT),
  fieldToHex(c0),
  fieldToHex(depositAppend.oldRoot),
  fieldToHex(depositAppend.newRoot),
  fieldToHex(BigInt(depositAppend.leafIndex)),
]);

// ------------------------------------------------------------------ spend ---
// Spend the deposited note: 700 stays as a private change note, 250 goes to a
// public recipient, 50 pays the relayer. The second output is a zero-value note,
// which is indistinguishable on chain from a funded one.

const membershipRoot = computeRoot([c0]);
const inputProof = merkleProof([c0], 0);
const change = { value: 700n, token, mpk: keys.mpk, blinding: 21n };
const filler = { value: 0n, token, mpk: keys.mpk, blinding: 22n };
const outs = [change, filler];
const outCommitments = outs.map(commitment);
const publicValue = 250n;
const fee = 50n;
// The chain the spend is bound to. The contract passes block.chainid, so the
// integration test sets vm.chainId to this. Robinhood testnet is 46630.
const CHAIN_ID = 46630n;

// A dummy input's leaf index is unconstrained, so it must land far outside the
// 0..2^20 range real leaves occupy or it would burn a real note's nullifier.
const dummyIndex = 0x7ea1ba5eba11n;

const append1 = appendProof([c0], outCommitments[0]);
const append2 = appendProof([c0, outCommitments[0]], outCommitments[1]);
const newRoot = append2.newRoot;

const spendInput = {
  sk: fieldToHex(keys.sk),
  token: fieldToHex(token),
  in_value: [fieldToHex(DEPOSIT), fieldToHex(0n)],
  in_blinding: [fieldToHex(deposited.blinding), fieldToHex(12n)],
  in_leaf_index: [fieldToHex(0n), fieldToHex(dummyIndex)],
  in_path: [inputProof.pathElements.map(fieldToHex), inputProof.pathElements.map(fieldToHex)],
  in_right: [inputProof.pathIndices.map((b) => b === 1), inputProof.pathIndices.map((b) => b === 1)],
  out_mpk: outs.map((o) => fieldToHex(o.mpk)),
  out_value: outs.map((o) => fieldToHex(o.value)),
  out_blinding: outs.map((o) => fieldToHex(o.blinding)),
  out_path: [append1.pathElements.map(fieldToHex), append2.pathElements.map(fieldToHex)],
  out_right: [append1.right, append2.right],
  membership_root: fieldToHex(membershipRoot),
  nullifiers: [fieldToHex(nullifier(keys.nk, 0)), fieldToHex(nullifier(keys.nk, dummyIndex))],
  out_commitments: outCommitments.map(fieldToHex),
  old_root: fieldToHex(membershipRoot),
  new_root: fieldToHex(newRoot),
  insert_index: fieldToHex(BigInt(append1.leafIndex)),
  public_token: fieldToHex(token),
  public_value: fieldToHex(publicValue),
  fee: fieldToHex(fee),
  recipient: fieldToHex(RECIPIENT),
  relayer: fieldToHex(RELAYER),
  chain_id: fieldToHex(CHAIN_ID),
};

// The order ShieldedPool.spend builds its publicInputs array in.
await proveInto("transfer", spendInput, [
  fieldToHex(membershipRoot),
  fieldToHex(nullifier(keys.nk, 0)),
  fieldToHex(nullifier(keys.nk, dummyIndex)),
  ...outCommitments.map(fieldToHex),
  fieldToHex(membershipRoot),
  fieldToHex(newRoot),
  fieldToHex(BigInt(append1.leafIndex)),
  fieldToHex(token),
  fieldToHex(publicValue),
  fieldToHex(fee),
  fieldToHex(RECIPIENT),
  fieldToHex(RELAYER),
  fieldToHex(CHAIN_ID),
]);

// ------------------------------------------------------------------ trade ---
// The adapter's chained pair: the same deposited note takes the other fork of
// history. 300 wei leave to the trade adapter, the venue swaps them for 900
// USDG units (the test sets the rate so that lands exactly), and the shield
// proof puts those 900 straight back — proven against the root the spend
// produces, so the two verify back to back in one transaction.
//
// The adapter and token addresses are constants: the Foundry test reads them
// out of these fixtures' public inputs and etches its contracts at exactly
// those addresses, so nothing here can drift from what the proofs bind.

const ADAPTER = 0x0000000000000000000000000000000000ada97en;
const USDG_TOKEN = 0x00000000000000000000000000000000000d0116n;
const TRADE_OUT = 300n; // wei unshielded to the adapter
const USDG_OUT = 900n; // units shielded back
const dummyIndex2 = 0x7ea1ba5eba22n;

const tradeChange = { value: DEPOSIT - TRADE_OUT, token, mpk: keys.mpk, blinding: 31n };
const tradeFiller = { value: 0n, token, mpk: keys.mpk, blinding: 32n };
const tradeOuts = [tradeChange, tradeFiller].map(commitment);
const tApp1 = appendProof([c0], tradeOuts[0]);
const tApp2 = appendProof([c0, tradeOuts[0]], tradeOuts[1]);

const tradeSpendInput = {
  sk: fieldToHex(keys.sk),
  token: fieldToHex(token),
  in_value: [fieldToHex(DEPOSIT), fieldToHex(0n)],
  in_blinding: [fieldToHex(deposited.blinding), fieldToHex(12n)],
  in_leaf_index: [fieldToHex(0n), fieldToHex(dummyIndex2)],
  in_path: [inputProof.pathElements.map(fieldToHex), inputProof.pathElements.map(fieldToHex)],
  in_right: [inputProof.pathIndices.map((b) => b === 1), inputProof.pathIndices.map((b) => b === 1)],
  out_mpk: [tradeChange, tradeFiller].map((o) => fieldToHex(o.mpk)),
  out_value: [tradeChange, tradeFiller].map((o) => fieldToHex(o.value)),
  out_blinding: [tradeChange, tradeFiller].map((o) => fieldToHex(o.blinding)),
  out_path: [tApp1.pathElements.map(fieldToHex), tApp2.pathElements.map(fieldToHex)],
  out_right: [tApp1.right, tApp2.right],
  membership_root: fieldToHex(membershipRoot),
  nullifiers: [fieldToHex(nullifier(keys.nk, 0)), fieldToHex(nullifier(keys.nk, dummyIndex2))],
  out_commitments: tradeOuts.map(fieldToHex),
  old_root: fieldToHex(membershipRoot),
  new_root: fieldToHex(tApp2.newRoot),
  insert_index: fieldToHex(BigInt(tApp1.leafIndex)),
  public_token: fieldToHex(token),
  public_value: fieldToHex(TRADE_OUT),
  fee: fieldToHex(0n),
  recipient: fieldToHex(ADAPTER),
  relayer: fieldToHex(0n),
  chain_id: fieldToHex(CHAIN_ID),
};
await proveInto("trade-spend", tradeSpendInput, [
  fieldToHex(membershipRoot),
  fieldToHex(nullifier(keys.nk, 0)),
  fieldToHex(nullifier(keys.nk, dummyIndex2)),
  ...tradeOuts.map(fieldToHex),
  fieldToHex(membershipRoot),
  fieldToHex(tApp2.newRoot),
  fieldToHex(BigInt(tApp1.leafIndex)),
  fieldToHex(token),
  fieldToHex(TRADE_OUT),
  fieldToHex(0n),
  fieldToHex(ADAPTER),
  fieldToHex(0n),
  fieldToHex(CHAIN_ID),
], "transfer");

const usdgNote = { value: USDG_OUT, token: USDG_TOKEN, mpk: keys.mpk, blinding: 33n };
const cUsdg = commitment(usdgNote);
const shieldBack = appendProof([c0, tradeOuts[0], tradeOuts[1]], cUsdg);
if (fieldToHex(shieldBack.oldRoot) !== fieldToHex(tApp2.newRoot)) {
  throw new Error("trade fixtures do not chain: the shield-back root must follow the spend");
}
const tradeShieldInput = {
  mpk: fieldToHex(keys.mpk),
  blinding: fieldToHex(usdgNote.blinding),
  insert_path: shieldBack.pathElements.map(fieldToHex),
  insert_right: shieldBack.right,
  token: fieldToHex(USDG_TOKEN),
  value: fieldToHex(USDG_OUT),
  commitment: fieldToHex(cUsdg),
  old_root: fieldToHex(shieldBack.oldRoot),
  new_root: fieldToHex(shieldBack.newRoot),
  leaf_index: fieldToHex(BigInt(shieldBack.leafIndex)),
};
await proveInto("trade-shield", tradeShieldInput, [
  fieldToHex(USDG_TOKEN),
  fieldToHex(USDG_OUT),
  fieldToHex(cUsdg),
  fieldToHex(shieldBack.oldRoot),
  fieldToHex(shieldBack.newRoot),
  fieldToHex(BigInt(shieldBack.leafIndex)),
], "shield");

console.log("\nfixtures written to circuits/target/{shield,transfer}-fixture/");

// ---------------------------------------------------------------- helpers ---

/** Prove `input` against the compiled circuit and write proof + public inputs.
 * `circuitName` defaults to `name` — the trade fixtures reuse the transfer and
 * shield circuits under their own fixture names. */
async function proveInto(name, input, expectedPublicInputs, circuitName = name) {
  const circuit = JSON.parse(
    await import("node:fs").then((fs) => fs.readFileSync(join(TARGET, `${circuitName}.json`), "utf8")),
  );
  const { witness } = await new Noir(circuit).execute(input);

  const api = await Barretenberg.new({ backend: BackendType.Wasm, threads: 4, srsSize: SRS_SIZE });
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const log = console.log;
    console.log = () => {};
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: "evm" });
    const ok = await backend.verifyProof({ proof, publicInputs }, { verifierTarget: "evm" });
    console.log = log;
    if (!ok) throw new Error(`${name}: bb refused its own proof`);

    const got = publicInputs.map((p) => "0x" + p.replace(/^0x/, "").padStart(64, "0"));
    if (got.length !== expectedPublicInputs.length) {
      throw new Error(`${name}: ${got.length} public inputs, expected ${expectedPublicInputs.length}`);
    }
    got.forEach((v, i) => {
      if (v !== expectedPublicInputs[i]) {
        throw new Error(`${name}: public input ${i} is ${v}, contract will pass ${expectedPublicInputs[i]}`);
      }
    });

    const dir = join(TARGET, `${name}-fixture`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proof"), Buffer.from(proof));
    writeFileSync(join(dir, "public_inputs.json"), JSON.stringify({ publicInputs: got }, null, 2));
    console.log(`${name}: ${proof.length}-byte proof, ${got.length} public inputs, order verified`);
  } finally {
    await api.destroy();
  }
}

/**
 * Bundle the client's note modules so the fixtures use the shipping code path.
 * Reimplementing Poseidon or the tree here would let the two drift silently,
 * which is the one thing these fixtures exist to catch.
 */
async function bundleClient() {
  const entry = join(TARGET, "_client-entry.ts");
  const out = join(TARGET, "_client.mjs");
  mkdirSync(TARGET, { recursive: true });
  writeFileSync(
    entry,
    ["keys", "note", "tree", "field", "circuit"].map((m) => `export * from "${CLI}/src/shielded/${m}.js";`).join("\n"),
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    external: ["@noble/*", "@zkpassport/*"],
    logLevel: "error",
  });
  const mod = await import(out);
  rmSync(entry);
  return mod;
}
