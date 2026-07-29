// Proves the circuit tests can fail.
//
// A `should_fail` test is worth nothing on its own. It passes when the circuit
// rejects the witness, and the circuit could be rejecting it for a reason that
// has nothing to do with the constraint the test is named after — a second
// mistake in the witness, a check further up, anything. The test would stay
// green after the constraint it supposedly guards was deleted, which is exactly
// the failure mode nobody notices.
//
// So delete each constraint and require the paired test to notice. When the
// constraint is gone, the adversarial witness becomes fully valid, the
// should_fail test passes unexpectedly, and nargo reports that as a failure.
// Mutant caught = nargo goes red on that one test.
//
// Two guards make the verdict trustworthy:
//
//   1. only the circuit is mutated, never the tests. The file is split at the
//      first `#[test` and the substitution is applied to the head alone, so a
//      pattern can never accidentally eat a `should_fail_with` string.
//   2. after each mutation the package's honest baseline must still pass. A
//      mutation that broke compilation would also make the paired test go red,
//      and without this it would be scored as a catch.
//
//   node audits/circuits/mutants.mjs           # every mutant
//   node audits/circuits/mutants.mjs leaf-index  # one, by name
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = join(HERE, "../../circuits");

/** The honest test that must keep passing under every mutation of a package. */
const BASELINE = {
  transfer: "the_adversarial_baseline_is_a_valid_spend",
  shield: "deposit_into_an_empty_tree",
};

// Each entry deletes exactly one constraint and names the test whose whole
// reason to exist is that constraint. The table doubles as documentation of
// what each adversarial test is actually for.
const MUTANTS = [
  // ---------------------------------------------------------------- transfer
  {
    name: "in-range",
    pkg: "transfer",
    test: "an_input_cannot_wrap_the_field_to_fake_its_value",
    find: /(let value = in_value\[i\];\s*\n\s*)value\.assert_max_bit_size::<VALUE_BITS>\(\);/,
    replace: "$1",
  },
  {
    name: "membership",
    pkg: "transfer",
    test: "cannot_spend_a_note_that_is_not_in_the_tree",
    find: /assert\(\(root - membership_root\) \* is_real == 0,[^;]*?;/s,
  },
  {
    name: "leaf-index",
    pkg: "transfer",
    test: "a_real_input_cannot_nullify_a_position_it_never_proved",
    find: /assert\(\(in_leaf_index\[i\] - index\) \* is_real == 0,[^;]*?;/s,
  },
  {
    name: "nullifier",
    pkg: "transfer",
    test: "a_nullifier_must_be_the_one_this_key_produces",
    find: /assert_eq\(nullifiers\[i\], nullify\(nk, in_leaf_index\[i\]\)\);/,
  },
  {
    name: "out-range",
    pkg: "transfer",
    test: "output_value_cannot_wrap_the_field",
    find: /(let value = out_value\[j\];\s*\n\s*)value\.assert_max_bit_size::<VALUE_BITS>\(\);/,
    replace: "$1",
  },
  {
    name: "out-commitment",
    pkg: "transfer",
    test: "an_output_note_cannot_be_worth_more_than_it_accounts_for",
    find: /assert_eq\(out_commitments\[j\], commit\([^;]*?\);/s,
  },
  {
    name: "append-root",
    pkg: "transfer",
    test: "outputs_must_append_to_the_current_tree",
    find: /assert\(before == root_cursor,[^;]*?;/s,
  },
  {
    name: "append-order",
    pkg: "transfer",
    test: "outputs_cannot_land_anywhere_but_the_index_the_chain_named",
    find: /assert\(index == insert_index \+ j as Field,[^;]*?;/s,
  },
  {
    name: "new-root",
    pkg: "transfer",
    test: "the_new_root_must_be_the_one_the_insertions_produce",
    find: /assert\(root_cursor == new_root,[^;]*?;/s,
  },
  {
    name: "public-range",
    pkg: "transfer",
    test: "the_public_leg_cannot_wrap_the_field_to_mint_change",
    find: /public_value\.assert_max_bit_size::<VALUE_BITS>\(\);/,
  },
  {
    name: "fee-range",
    pkg: "transfer",
    test: "the_fee_cannot_wrap_the_field_to_mint_change",
    find: /fee\.assert_max_bit_size::<VALUE_BITS>\(\);/,
  },
  {
    name: "asset-binding",
    pkg: "transfer",
    test: "a_paid_send_cannot_hide_its_asset",
    find: /assert\(\s*\(public_value \+ fee\) \* \(public_token - token\) == 0,[^;]*?;/s,
  },
  {
    name: "conservation",
    pkg: "transfer",
    test: "send_cannot_mint_value",
    find: /assert\(sum_in == sum_out \+ public_value \+ fee,[^;]*?;/s,
  },
  // ------------------------------------------------------------------ shield
  {
    name: "shield-commitment",
    pkg: "shield",
    test: "wrong_blinding_fails",
    find: /assert_eq\(commit\(mpk, token, value, blinding\), commitment\);/,
  },
  {
    name: "shield-old-root",
    pkg: "shield",
    test: "cannot_insert_against_a_tree_the_chain_does_not_have",
    find: /assert\(before == old_root,[^;]*?;/s,
  },
  {
    name: "shield-new-root",
    pkg: "shield",
    test: "cannot_claim_an_unrelated_new_root",
    find: /assert\(after == new_root,[^;]*?;/s,
  },
  {
    name: "shield-leaf-index",
    pkg: "shield",
    test: "cannot_claim_a_leaf_index_the_path_does_not_reach",
    find: /assert\(index == leaf_index,[^;]*?;/s,
  },
];

const srcOf = (pkg) => join(CIRCUITS, pkg, "src/main.nr");

/** Run one nargo test. Returns true when nargo is happy. */
function nargo(pkg, testName) {
  try {
    execFileSync("nargo", ["test", testName], {
      cwd: join(CIRCUITS, pkg),
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a mutation to the circuit half of the file only. Everything from the
 * first `#[test` onward is left untouched, so no pattern can reach a test.
 */
function mutate(original, m) {
  const cut = original.indexOf("#[test");
  if (cut === -1) throw new Error("no tests found in the file");
  const head = original.slice(0, cut);
  const tail = original.slice(cut);

  const hits = head.match(new RegExp(m.find.source, m.find.flags + "g"));
  if (!hits) return null;
  if (hits.length !== 1) {
    throw new Error(`${m.name}: matched ${hits.length} sites, expected exactly 1`);
  }
  return head.replace(m.find, m.replace ?? "") + tail;
}

const wanted = process.argv[2];
const chosen = wanted ? MUTANTS.filter((m) => m.name === wanted) : MUTANTS;
if (wanted && chosen.length === 0) {
  console.error(`no mutant named ${wanted}`);
  process.exit(2);
}

// Snapshot every file we might touch, and put it back whatever happens.
const originals = new Map();
for (const pkg of new Set(chosen.map((m) => m.pkg))) {
  originals.set(pkg, readFileSync(srcOf(pkg), "utf8"));
}
const restore = () => {
  for (const [pkg, text] of originals) writeFileSync(srcOf(pkg), text);
};
process.on("exit", restore);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

console.log("checking the circuits are green before mutating anything");
for (const pkg of originals.keys()) {
  if (!nargo(pkg, BASELINE[pkg])) {
    console.error(`FAIL  ${pkg} baseline ${BASELINE[pkg]} does not pass unmutated`);
    process.exit(2);
  }
}

console.log();
console.log("MUTANT              RESULT      TEST");
console.log("-".repeat(78));

let caught = 0;
let survived = 0;
let broken = 0;

for (const m of chosen) {
  const original = originals.get(m.pkg);
  let mutated;
  try {
    mutated = mutate(original, m);
  } catch (e) {
    console.log(`${m.name.padEnd(19)} ERROR       ${e.message}`);
    broken++;
    continue;
  }
  if (mutated === null) {
    console.log(`${m.name.padEnd(19)} NO-OP       pattern matched nothing, the circuit moved`);
    broken++;
    continue;
  }

  writeFileSync(srcOf(m.pkg), mutated);

  // The honest path must survive the mutation, or a red paired test would only
  // mean the circuit stopped compiling.
  const baselineOk = nargo(m.pkg, BASELINE[m.pkg]);
  const pairedRed = !nargo(m.pkg, m.test);

  writeFileSync(srcOf(m.pkg), original);

  if (!baselineOk) {
    console.log(`${m.name.padEnd(19)} INVALID     mutation broke ${BASELINE[m.pkg]}`);
    broken++;
  } else if (pairedRed) {
    console.log(`${m.name.padEnd(19)} caught      ${m.test}`);
    caught++;
  } else {
    console.log(`${m.name.padEnd(19)} SURVIVED    ${m.test}`);
    survived++;
  }
}

restore();
console.log();
if (survived === 0 && broken === 0) {
  console.log(`${caught}/${caught} mutants caught. Circuits restored.`);
  process.exit(0);
}
console.log(
  `${caught} caught, ${survived} survived, ${broken} unusable, out of ${chosen.length}. Circuits restored.`,
);
console.log(
  "A survivor means the named test does not actually depend on the constraint it guards.",
);
process.exit(1);
