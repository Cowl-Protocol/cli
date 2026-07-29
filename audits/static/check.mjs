// The static scan as a gate, not as a report.
//
// Both scanners find something on every run and always will: 15 slither
// findings and 5 aderyn detectors survive the current triage, every one of them
// read against source and written up in README.md. So "fail if the scanner
// found anything" is useless here — it would be red forever, and a gate that is
// always red is a gate everyone learns to route around.
//
// What this does instead is compare against a recorded baseline and fail on
// anything NEW. Same shape as the pool watcher in ../monitoring: the accepted
// state is committed, and the check is about drift from it.
//
//   node audits/static/check.mjs            # scan and compare
//   node audits/static/check.mjs --update   # re-record the baseline
//
// Exit codes, deliberately distinct:
//   0  no new findings
//   1  something new, or something the baseline expects is gone
//   2  could not check — a scanner is missing or produced nothing
//
// ## Why the fingerprint has no line numbers
//
// A finding is identified by detector + where it lives, and "where" is the
// contract and the function, not the line. Line numbers move every time anyone
// edits anything above them, and a gate that goes red on an unrelated edit is
// the same always-red gate by a slower route. The cost is that a second
// instance of an already-accepted pattern in the same function would not
// register, so the count per fingerprint is tracked too — one more
// `missing-zero-check` in a constructor that already has one still fails.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "baseline.json");
const UPDATE = process.argv.includes("--update");

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

for (const tool of ["slither", "aderyn"]) {
  try {
    execFileSync("which", [tool], { stdio: "pipe" });
  } catch {
    die(2, `${tool} is not on PATH. Install it, or this check cannot say anything.`);
  }
}

const work = mkdtempSync(join(tmpdir(), "cowl-scan-"));
try {
  console.log("running the scanners into a scratch directory");
  try {
    execFileSync(join(HERE, "scan.sh"), [work], { stdio: "pipe" });
  } catch (e) {
    die(2, `scan.sh failed:\n${e.stderr?.toString() ?? e.message}`);
  }

  const slitherPath = join(work, "slither-raw.json");
  const aderynPath = join(work, "aderyn-raw.json");
  if (!existsSync(slitherPath)) die(2, "slither produced no JSON");
  if (!existsSync(aderynPath)) die(2, "aderyn produced no JSON");

  /** detector + the contract and function it sits in. No line numbers, see above. */
  const found = new Map();
  const bump = (key) => found.set(key, (found.get(key) ?? 0) + 1);

  const slither = JSON.parse(readFileSync(slitherPath, "utf8"));
  if (slither.success !== true) die(2, `slither reported failure: ${slither.error}`);
  for (const f of slither.results.detectors) {
    const e = f.elements[0] ?? {};
    const file = e.source_mapping?.filename_short ?? "?";
    bump(`slither|${f.check}|${file}|${e.type ?? "?"} ${e.name ?? "?"}`);
  }

  const aderyn = JSON.parse(readFileSync(aderynPath, "utf8"));
  for (const sev of ["critical_issues", "high_issues", "medium_issues", "low_issues"]) {
    for (const issue of aderyn[sev]?.issues ?? []) {
      for (const inst of issue.instances ?? []) {
        bump(`aderyn|${issue.detector_name}|${inst.contract_path}`);
      }
    }
  }

  if (found.size === 0) {
    die(2, "both scanners produced zero findings, which has never happened. Something did not run.");
  }

  const current = Object.fromEntries([...found.entries()].sort());

  if (UPDATE) {
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          note:
            "Accepted static-analysis findings. Every one is triaged in README.md. " +
            "Regenerate with: node audits/static/check.mjs --update",
          slitherVersion: execFileSync("slither", ["--version"]).toString().trim(),
          aderynVersion: execFileSync("aderyn", ["--version"]).toString().trim(),
          findings: current,
        },
        null,
        2,
      ) + "\n",
    );
    const total = [...found.values()].reduce((a, b) => a + b, 0);
    console.log(`recorded ${found.size} fingerprints, ${total} instances, into baseline.json`);
    process.exit(0);
  }

  if (!existsSync(BASELINE)) {
    die(2, "no baseline.json. Record one with: node audits/static/check.mjs --update");
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8")).findings;

  const appeared = [];
  const grew = [];
  const gone = [];
  const shrank = [];

  for (const [k, n] of Object.entries(current)) {
    const was = base[k];
    if (was === undefined) appeared.push(`${k}  (x${n})`);
    else if (n > was) grew.push(`${k}  ${was} -> ${n}`);
    else if (n < was) shrank.push(`${k}  ${was} -> ${n}`);
  }
  for (const k of Object.keys(base)) if (current[k] === undefined) gone.push(k);

  const say = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label}`);
    for (const l of list) console.log(`  ${l}`);
  };

  say("NEW — not in the baseline, nobody has read these yet:", appeared);
  say("MORE — an accepted finding now has more instances:", grew);
  say("FEWER — an accepted finding shrank, tighten the baseline:", shrank);
  say("GONE — the baseline expects these and they did not appear:", gone);

  const total = [...found.values()].reduce((a, b) => a + b, 0);
  if (appeared.length || grew.length) {
    console.log(
      `\n${appeared.length + grew.length} finding(s) nobody has triaged.` +
        "\nRead them against source, write the verdict into README.md, then run --update.",
    );
    process.exit(1);
  }
  if (gone.length || shrank.length) {
    // Not a security failure, but the baseline is now claiming more than the
    // scan supports, and a stale baseline quietly stops catching things.
    console.log("\nnothing new, but the baseline is out of date. Re-record it with --update.");
    process.exit(1);
  }
  console.log(`\nno new findings — ${found.size} fingerprints, ${total} instances, all triaged`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
