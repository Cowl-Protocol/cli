// The public inputs the circuit declares, against the ones the pool passes.
//
// This is the one binding a Noir test cannot reach. `recipient`, `relayer` and
// `chain_id` are held in the constraint system by a single line in `transfer`:
//
//     let payout_tag = Poseidon2::hash([recipient, relayer, chain_id], 3);
//     assert(payout_tag != 0);
//
// That assertion is true for essentially every input, so it pins no value. Its
// job is different: it makes the three wires participate, so the compiler
// cannot optimise them out of the circuit. The actual binding comes from the
// verifier checking the proof's public inputs against what the contract hands
// it — and that only works if both sides agree on how many there are and what
// order they are in.
//
// A dropped input is loud: the counts stop matching and every proof fails. A
// SWAPPED pair is silent, and catastrophic — the verifier would happily check a
// recipient against a relayer. Nothing else in this repository compares the two
// sides, so this does.
//
//   node audits/circuits/publicinputs.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../..");

/**
 * The agreed pairing, reviewed by hand. Left is the circuit's flattened public
 * input, right is the expression the pool assigns at that index. Reorder either
 * side of the system and this table stops matching.
 */
const PAIRING = {
  transfer: {
    circuit: join(CLI, "circuits/target/transfer.json"),
    fn: "spend",
    pairs: [
      ["membership_root", "s.membershipRoot"],
      ["nullifiers[0]", "s.nullifiers[0]"],
      ["nullifiers[1]", "s.nullifiers[1]"],
      ["out_commitments[0]", "s.commitments[0]"],
      ["out_commitments[1]", "s.commitments[1]"],
      ["old_root", "oldRoot"],
      ["new_root", "s.newRoot"],
      ["insert_index", "insertIndex"],
      ["public_token", "s.token"],
      ["public_value", "s.value"],
      ["fee", "s.fee"],
      ["recipient", "s.recipient"],
      ["relayer", "s.relayer"],
      ["chain_id", "block.chainid"],
    ],
  },
  shield: {
    circuit: join(CLI, "circuits/target/shield.json"),
    fn: "shield",
    pairs: [
      ["token", "token"],
      ["value", "value"],
      ["commitment", "commitment"],
      ["old_root", "oldRoot"],
      ["new_root", "newRoot"],
      ["leaf_index", "leafIndex"],
    ],
  },
};

/** Flatten the ABI's public parameters the way the verifier sees them. */
function circuitPublicInputs(path) {
  const abi = JSON.parse(readFileSync(path, "utf8")).abi;
  const out = [];
  for (const p of abi.parameters) {
    if (p.visibility !== "public") continue;
    if (p.type.kind === "array") {
      for (let i = 0; i < p.type.length; i++) out.push(`${p.name}[${i}]`);
    } else {
      out.push(p.name);
    }
  }
  return out;
}

/**
 * The expressions the pool assigns to `publicInputs[i]`, in index order, with
 * the casts stripped. Read out of the named function only, so `shield` and
 * `spend` cannot be confused for each other.
 */
function poolPublicInputs(fnName) {
  const src = readFileSync(join(CLI, "contracts/src/ShieldedPool.sol"), "utf8");
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`no function ${fnName} in ShieldedPool.sol`);
  const next = src.indexOf("\n    function ", start + 1);
  const body = src.slice(start, next === -1 ? src.length : next);

  const found = [];
  const re = /publicInputs\[(\d+)\]\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let expr = m[2].trim();
    // Strip the casts the ABI has no opinion about: bytes32(...), uint256(...),
    // uint160(...). What is left is the value being committed to.
    let prev;
    do {
      prev = expr;
      expr = expr.replace(/^(bytes32|uint256|uint160)\((.*)\)$/s, "$2").trim();
    } while (expr !== prev);
    found[Number(m[1])] = expr;
  }
  return found;
}

let failed = 0;
const check = (ok, label, detail = "") => {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
};

for (const [name, spec] of Object.entries(PAIRING)) {
  console.log(`\n${name}`);
  const circuit = circuitPublicInputs(spec.circuit);
  const pool = poolPublicInputs(spec.fn);

  check(
    circuit.length === spec.pairs.length,
    `circuit declares ${spec.pairs.length} public inputs`,
    `got ${circuit.length}: ${circuit.join(", ")}`,
  );
  check(
    pool.length === spec.pairs.length,
    `${spec.fn}() passes ${spec.pairs.length} public inputs`,
    `got ${pool.length}`,
  );
  check(
    !pool.includes(undefined),
    `${spec.fn}() leaves no index unassigned`,
    `holes at ${pool.map((v, i) => (v === undefined ? i : null)).filter((v) => v !== null).join(", ")}`,
  );

  for (let i = 0; i < spec.pairs.length; i++) {
    const [wantCircuit, wantPool] = spec.pairs[i];
    check(
      circuit[i] === wantCircuit && pool[i] === wantPool,
      `[${String(i).padStart(2)}] ${wantCircuit} = ${wantPool}`,
      `circuit has ${circuit[i]}, pool has ${pool[i]}`,
    );
  }
}

// The one the whole file exists for: the payout wires are still declared. If a
// future edit stops using them in the circuit and the compiler drops them, the
// counts above break — but say it plainly too, because this is the constraint
// that has no test of its own.
const transferInputs = circuitPublicInputs(PAIRING.transfer.circuit);
console.log("\nthe payout binding");
for (const wire of ["recipient", "relayer", "chain_id"]) {
  check(transferInputs.includes(wire), `${wire} survives compilation as a public input`);
}

console.log();
if (failed) {
  console.error(`${failed} failing`);
  process.exit(1);
}
console.log("circuit and pool agree on every public input");
