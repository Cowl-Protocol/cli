// Proves the relayer suite can fail.
//
//   node audits/relayer/mutants.mjs              every mutant
//   node audits/relayer/mutants.mjs tier-spread  one, by name
//
// The rule the invariant, circuit and monitoring harnesses are built on: a
// suite that has only ever been green has demonstrated nothing. Each mutant
// deletes exactly one defence from the daemon and requires the case that names
// it to go red. A survivor means the case does not constrain the code it is
// written against, and the run exits 1 on one.
//
// The source is edited in place. It is restored in a finally and on SIGINT,
// SIGTERM and SIGHUP, with a byte-for-byte check at the end — a killed harness
// that leaves a defence deleted in the working tree is worse than one that
// never ran.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../..");
const SERVER = join(CLI, "src/relayer/server.ts");
const CLIENT = join(CLI, "src/relayer/client.ts");
const ATTACK = join(HERE, "attack.mjs");

const MUTANTS = [
  {
    name: "tier-spread",
    file: SERVER,
    caughtBy: "tier-spread",
    removes: "the refusal when the venue's tiers disagree",
    find: `  if (cheapest * MAX_TIER_SPREAD < dearest) {
    throw new Error(
      "This venue's fee tiers disagree about that token by too much to price a fee against — withdraw the native coin, or submit it yourself.",
    );
  }
`,
    replace: "",
  },
  {
    name: "inflight",
    file: SERVER,
    caughtBy: "quote-flood",
    removes: "the cap on requests doing upstream work at once",
    find: `      if (inflight >= MAX_INFLIGHT) {`,
    replace: `      if (false) {`,
  },
  {
    // Moved, not deleted. Deleting the cap would leave the ninth spend waiting
    // in a queue that never drains, and the case would time out rather than
    // report — a hang scored as "could not run", which is not a verdict. This
    // puts the check back exactly where it sat before this audit: after the
    // pricing it was supposed to be protecting.
    name: "queue-order",
    caughtBy: "full-queue",
    removes: "checking the queue before pricing the fee",
    edits: [
      {
        file: SERVER,
        find: `          if (queued >= MAX_QUEUE) {
            onEvent({ kind: "rejected", reason: "queue full" });
            send(res, 429, { error: "Relayer is busy — retry shortly." });
            return;
          }
          const floorWei = await feeNow(net, 0);`,
        replace: `          const floorWei = await feeNow(net, 0);`,
      },
      {
        file: SERVER,
        find: `            throw new Reprove(\`Fee too low: the spend pays \${spend.fee}, gas costs \${floor}. Re-quote and reprove.\`);
          }

          queued += 1;`,
        replace: `            throw new Reprove(\`Fee too low: the spend pays \${spend.fee}, gas costs \${floor}. Re-quote and reprove.\`);
          }
          if (queued >= MAX_QUEUE) {
            onEvent({ kind: "rejected", reason: "queue full" });
            send(res, 429, { error: "Relayer is busy — retry shortly." });
            return;
          }

          queued += 1;`,
      },
    ],
  },
  {
    name: "rpc-leak",
    file: SERVER,
    caughtBy: "rpc-leak",
    removes: "stripping the endpoint out of what a caller is told",
    find: `      .filter((line) => !/^\\s*(URL|Request body|Version)\\s*:/i.test(line))`,
    replace: `      .filter(() => true)`,
  },
  {
    name: "sweep-catch",
    file: SERVER,
    caughtBy: "survive-blip",
    removes: "the sweep's balance read from inside the try",
    find: `    sweeping = true;
    try {
      const float = await publicClient(net).getBalance({ address: account.address });`,
    replace: `    const float = await publicClient(net).getBalance({ address: account.address });
    sweeping = true;
    try {`,
  },
  {
    // Compound, and it has to be. The guard only does anything when something
    // throws after the response has gone out, and the sweep's balance read is
    // the only thing that can — so removing the guard alone leaves nothing to
    // guard against, and the case would score it as caught for the wrong
    // reason. Both edits together are the shape the daemon had before this
    // audit, where one RPC blip killed the process.
    name: "double-send",
    caughtBy: "survive-blip",
    removes: "the guard against answering one request twice, with an after-response throw to reach it",
    edits: [
      { file: SERVER, find: `  if (res.headersSent) return;\n`, replace: "" },
      {
        file: SERVER,
        find: `    sweeping = true;
    try {
      const float = await publicClient(net).getBalance({ address: account.address });`,
        replace: `    const float = await publicClient(net).getBalance({ address: account.address });
    sweeping = true;
    try {`,
      },
    ],
  },
  {
    name: "sweep-detached",
    file: SERVER,
    caughtBy: "sweep-nonce",
    removes: "holding the queue while the sweep sends its own transactions",
    find: `            await maybeSweep();`,
    replace: `            void maybeSweep();`,
  },
  {
    name: "wide-field",
    file: CLIENT,
    caughtBy: "wide-field",
    removes: "the width bound on a decimal field",
    find: ` || v.length > MAX_DIGITS`,
    replace: "",
  },
];

const ONLY = process.argv[2];
const chosen = ONLY ? MUTANTS.filter((m) => m.name === ONLY) : MUTANTS;
if (ONLY && chosen.length === 0) {
  console.error(`No mutant named ${ONLY}. Have: ${MUTANTS.map((m) => m.name).join(", ")}`);
  process.exit(2);
}

const originals = new Map([
  [SERVER, readFileSync(SERVER, "utf8")],
  [CLIENT, readFileSync(CLIENT, "utf8")],
]);

function restore() {
  for (const [file, text] of originals) writeFileSync(file, text);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

/** Run one case of the attack suite. Resolves to its exit code. */
function runCase(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ATTACK, name], { cwd: CLI, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let failures = 0;
try {
  // The control. Every verdict below is "the case went red when the defence
  // went away", which means nothing unless it was green with the defence there.
  process.stdout.write("control: the unmutated suite ... ");
  const control = await runCase("");
  if (control.code !== 0) {
    console.log("RED");
    console.log(control.out);
    console.error("The suite does not pass unmutated, so no mutant verdict below would mean anything.");
    process.exit(2);
  }
  console.log("green\n");

  for (const m of chosen) {
    const edits = m.edits ?? [{ file: m.file, find: m.find, replace: m.replace }];
    // Each edit is applied to the pristine source and must match exactly one
    // site. A pattern that matches nothing, or matches twice, is an error —
    // never a silent skip that would be scored as a surviving mutant.
    const staged = new Map();
    let bad = false;
    for (const e of edits) {
      const source = staged.get(e.file) ?? originals.get(e.file);
      const hits = source.split(e.find).length - 1;
      if (hits !== 1) {
        console.error(`  ${m.name}: a pattern matches ${hits} sites in ${e.file}, not 1. The harness needs updating.`);
        bad = true;
        break;
      }
      staged.set(e.file, source.replace(e.find, e.replace));
    }
    if (bad) {
      failures += 1;
      continue;
    }
    for (const [file, text] of staged) writeFileSync(file, text);

    const { code, out } = await runCase(m.caughtBy);
    restore();

    // A daemon that died of its own error handling is the loudest catch there
    // is, and it never reaches the suite's own reporting.
    if (/ERR_HTTP_HEADERS_SENT|UnhandledPromiseRejection/.test(out)) {
      console.log(`  caught    ${m.name.padEnd(15)} the daemon died: ${/ERR_HTTP_HEADERS_SENT/.test(out) ? "answered one request twice" : "unhandled rejection"}`);
      continue;
    }
    // Exit 2 is the suite refusing to report — a mutant that broke compilation
    // would otherwise be scored as a catch.
    if (code === 2 || /threw:/.test(out)) {
      console.log(`  SURVIVED  ${m.name.padEnd(15)} the suite could not run against it`);
      console.log(out.split("\n").filter((l) => l.trim()).slice(-4).map((l) => `      ${l}`).join("\n"));
      failures += 1;
    } else if (code === 0) {
      console.log(`  SURVIVED  ${m.name.padEnd(15)} ${m.caughtBy} still passed without ${m.removes}`);
      failures += 1;
    } else {
      const line = out.split("\n").find((l) => l.includes("FAIL")) ?? "";
      console.log(`  caught    ${m.name.padEnd(15)} ${line.trim() || `${m.caughtBy} went red`}`);
    }
  }
} finally {
  restore();
  for (const [file, text] of originals) {
    if (readFileSync(file, "utf8") !== text) {
      console.error(`\n${file} was NOT restored. Check it before doing anything else.`);
      process.exit(2);
    }
  }
}

console.log(`\n${chosen.length - failures}/${chosen.length} caught. Sources restored byte for byte.`);
process.exit(failures ? 1 : 0);
