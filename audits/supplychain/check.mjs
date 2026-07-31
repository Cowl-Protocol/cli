// The dependency tree as a gate, not as a report.
//
// Same shape as ../static/check.mjs and the pool watcher: the accepted state is
// committed, and the check is about drift from it. `npm audit` alone would be
// the always-red gate that one warns about — the app tree carries 36 advisories
// today, every one of them read and rebutted with evidence in README.md — so
// failing on "found something" would teach everyone to route around it.
//
//   node audits/supplychain/check.mjs            # check this repository
//   node audits/supplychain/check.mjs --update   # re-record install scripts only
//
// Exit codes, deliberately distinct:
//   0  nothing new
//   1  something new, or something the baseline expects is gone
//   2  could not check — no lockfile, or the registry never answered
//
// ## The two halves, and why one of them is the point
//
// **Install scripts** are the half that matters. `npm i` runs them as the user
// who typed it, before a single line of the package is imported, on a machine
// that in this project sits beside a keystore. A package that gains one between
// two releases is the whole modern supply-chain attack in one event, and no
// scanner in audits/ can see it: slither and aderyn read Solidity, CodeQL reads
// our own source, and the invariant suite reads a contract. This is the only
// control here that looks at what arrives from outside.
//
// That half is offline. It reads the lockfile and nothing else, so it works on
// a plane and cannot fail for a reason that has nothing to do with the repo.
//
// **Advisories** are the half that is mostly noise, kept because the signal is
// real when it comes. It needs the registry, which is why it degrades to exit 2
// rather than pretending a clean result.
//
// ## Why `--update` only re-records install scripts
//
// Accepting an advisory means writing down why it does not reach anything,
// which is a sentence a person has to author. A flag that swept them into the
// baseline would turn a triage step into a keystroke, and the baseline would
// stop meaning "read and rebutted". Advisories are added by hand, with a
// verdict, or the gate stays red.
//
// ## Why this file exists twice
//
// The same gate runs in `Cowl-Protocol/cli` and `Cowl-Protocol/app`, because the
// app's build machine turns 900-odd packages into the bundle every browser runs,
// and that bundle is where a wallet signature becomes a spending key. Two
// repositories, two lockfiles, so two gates.
//
// Duplication is the cheaper of the two options only until the copies drift, so
// they do not get to drift quietly: **the two files are byte-identical**, each
// baseline records the sha256 of the file beside it, and each copy checks its
// own. Edit one and that repository goes red until somebody re-records it, which
// is the moment to copy the change across. Compare the `twinSha` in the two
// baselines and you know whether they are in sync without reading either file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const BASELINE = join(HERE, "baseline.json");
const UPDATE = process.argv.includes("--update");
const LOCK = join(REPO, "package-lock.json");

const say = (s = "") => console.log(s);
const ok = (l) => say(`  ok     ${l}`);
const bad = (l) => say(`  FAIL   ${l}`);
const note = (l) => say(`  ·      ${l}`);

// Read first and explain on failure, rather than testing for the file and then
// reading it. The two-step version is a check-then-use race — CodeQL flags it as
// js/file-system-race, and it found this one — and the single-step version is
// also just better: it cannot report "missing" for a file that is present but
// unreadable, or malformed.
function readJson(path, missing) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(e.code === "ENOENT" ? missing : `Cannot read ${path}: ${e.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`${path} is not valid JSON.`);
    process.exit(2);
  }
}

const lock = readJson(LOCK, `No package-lock.json at ${LOCK}. Nothing to check against.`);
const baseline = readJson(
  BASELINE,
  `No baseline at ${BASELINE}. Record one with --update, then triage it by hand.`,
);

// ------------------------------------------------------- install scripts ---
// `optional: true` is recorded but never treated as safe. An optional package
// still installs by default; optional means npm tolerates it failing, not that
// it declines to run it.
const scripts = [];
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || !entry.hasInstallScript) continue;
  const name = path.replace(/^.*node_modules\//, "");
  scripts.push({
    name,
    version: entry.version ?? "",
    dev: Boolean(entry.dev),
    optional: Boolean(entry.optional),
  });
}
scripts.sort((a, b) => a.name.localeCompare(b.name));

// ------------------------------------------------------------ the twin ---
// Hashed from disk rather than from anything this process holds, so the check
// is about the file that will be copied, not about what happens to be running.
const SELF = fileURLToPath(import.meta.url);
const selfSha = createHash("sha256").update(readFileSync(SELF)).digest("hex");

if (UPDATE) {
  const merged = { ...baseline, twinSha: selfSha, installScripts: scripts };
  writeFileSync(BASELINE, `${JSON.stringify(merged, null, 2)}\n`);
  say(`Recorded ${scripts.length} package${scripts.length === 1 ? "" : "s"} with install scripts.`);
  say(`Recorded twinSha ${selfSha.slice(0, 12)}… — copy this file to the other repository and`);
  say("re-record there too, or the two gates are running different code.");
  say("Commit it, and write down in README.md why each one is acceptable.");
  process.exit(0);
}

let failures = 0;

say();
say("Twin");
if (!baseline.twinSha) {
  failures += 1;
  bad("no twinSha in the baseline — record one with --update");
} else if (baseline.twinSha !== selfSha) {
  failures += 1;
  bad(`this gate has been edited since it was recorded (${selfSha.slice(0, 12)}… vs ${baseline.twinSha.slice(0, 12)}…)`);
  note("copy it to the other repository, then re-record both with --update");
} else {
  ok(`gate matches its recorded copy (${selfSha.slice(0, 12)}…)`);
}

say();
say("Install scripts");
const accepted = new Map((baseline.installScripts ?? []).map((s) => [s.name, s]));
const seen = new Set();
for (const s of scripts) {
  seen.add(s.name);
  const was = accepted.get(s.name);
  const where = `${s.dev ? "dev" : "PRODUCTION"}${s.optional ? ", optional" : ""}`;
  if (!was) {
    failures += 1;
    bad(`${s.name} ${s.version} runs an install script and is not in the baseline (${where})`);
  } else if (was.dev && !s.dev) {
    // The severity of an install script is entirely about who runs it. One that
    // moves from the build machine into what a user installs is a different
    // finding wearing the same name.
    failures += 1;
    bad(`${s.name} was a dev dependency and is now in the production tree`);
  } else {
    ok(`${s.name} ${s.version} (${where}, accepted)`);
  }
}
for (const name of accepted.keys()) {
  if (!seen.has(name)) note(`${name} no longer runs an install script — drop it from the baseline`);
}

// ------------------------------------------------------------ advisories ---
say();
say("Advisories");
let audit = null;
try {
  // npm audit exits nonzero whenever it finds anything, so the status is not
  // the signal here and the output is parsed either way.
  audit = execFileSync("npm", ["audit", "--json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (e) {
  audit = e.stdout ?? null;
}
if (!audit) {
  say();
  say("Install scripts checked. The registry never answered, so advisories were not.");
  process.exit(failures > 0 ? 1 : 2);
}

let found;
try {
  const parsed = JSON.parse(audit);
  found = new Map();
  for (const [pkg, v] of Object.entries(parsed.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via.url) continue;
      // Keyed by advisory and package, not by version range: a range moves
      // every time anything in the tree shifts, and this gate is about whether
      // a NEW advisory appeared, not about which patch level it starts at.
      found.set(`${pkg}|${via.url}`, { pkg, url: via.url, severity: via.severity, title: via.title });
    }
  }
} catch {
  say();
  say("Install scripts checked. npm audit produced output that could not be read.");
  process.exit(failures > 0 ? 1 : 2);
}

const acceptedAdvisories = new Set((baseline.advisories ?? []).map((a) => `${a.package}|${a.url}`));
const fresh = [...found.values()].filter((f) => !acceptedAdvisories.has(`${f.pkg}|${f.url}`));
if (fresh.length === 0) {
  ok(`${found.size} advisor${found.size === 1 ? "y" : "ies"}, all triaged in README.md`);
} else {
  failures += fresh.length;
  for (const f of fresh) bad(`${(f.severity ?? "?").toUpperCase()} ${f.pkg} — ${f.title ?? f.url}`);
  say();
  say("A new advisory is red until somebody reads it and writes a verdict into");
  say("audits/supplychain/README.md, then adds it to baseline.json by hand.");
}

say();
if (failures > 0) {
  say(`${failures} thing${failures === 1 ? "" : "s"} to look at.`);
  process.exit(1);
}
say("Nothing new.");
process.exit(0);
