// Proves the relayer alarms can fire.
//
// The same rule the invariant and circuit harnesses are built on: a watcher
// that has only ever printed "All clear" has demonstrated nothing. Governance
// and turnstile drift were already proven to alarm by moving the recorded
// baseline. The relayer checks cannot be proven that way, because what they
// read is a live daemon rather than a recorded expectation — so this stands a
// stub relayer up on loopback, points the network definition at it, and makes
// it lie in one specific way per mutant.
//
//   node audits/monitoring/mutants.mjs            # every mutant
//   node audits/monitoring/mutants.mjs float-low  # one, by name
//
// The chain reads are real and hit testnet. Only the relayer is faked, and
// `src/networks.ts` is edited in place and restored in a finally, with a
// byte-for-byte check at the end that it really was.
//
// A mutant passes when the alarm it targets appears AND the run exits 1. Other
// alarms firing alongside it is fine and sometimes unavoidable: pointing the
// payout at another address moves the float too. What is being proven is that
// each alarm is reachable, not that it is reachable alone.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../..");
const NETWORKS = join(CLI, "src/networks.ts");
const WATCHER = join(CLI, "scripts/watch-pool.mjs");
const NET = "robinhood-testnet";

// Unique because mainnet's URL carries a /mainnet suffix, so the closing quote
// is what makes this match the testnet entry and only the testnet entry.
const TESTNET_RELAY = '"https://relay.cowlprotocol.com"';

const original = readFileSync(NETWORKS, "utf8");
if (!original.includes(TESTNET_RELAY)) {
  console.error(`Could not find the ${NET} relay URL in src/networks.ts. The harness needs updating.`);
  process.exit(2);
}

// What an honest quote from the testnet relayer looks like, as the baseline
// records it. Each mutant changes exactly one field.
const TRUTH = {
  relayer: "0xEAd4E3Ee1715aF246BF39D958163Ba91892127A0",
  pool: "0xf9F825f2D6d8509c78baaa587694f74672C32A59",
  chainId: 46630,
  feeWei: "55000000000000",
  token: "0",
};

/** Stub relayer. `shape` rewrites the quote body; null means refuse to answer. */
function stub(shape) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = shape({ ...TRUTH });
      // floatWei defaults to something the chain will agree with, so the
      // cross-check stays quiet unless a mutant is aiming at it.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ fee: body.feeWei, floatWei: "40000000000000000", spendsLeft: "722", ...body }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// name | alarm that must appear | quote shape, or null to serve nothing
const MUTANTS = [
  ["relay-down", "RELAYER NOT ANSWERING", null],
  ["wrong-chain", "RELAYER ON THE WRONG CHAIN", (q) => ({ ...q, chainId: 1 })],
  ["wrong-pool", "RELAYER ON THE WRONG POOL", (q) => ({ ...q, pool: "0x000000000000000000000000000000000000dEaD" })],
  [
    "payout-drift",
    "RELAYER PAYOUT ADDRESS CHANGED",
    (q) => ({ ...q, relayer: "0x000000000000000000000000000000000000dEaD" }),
  ],
  ["zero-fee", "RELAYER QUOTES A ZERO FEE", (q) => ({ ...q, feeWei: "0" })],
  // A fee this size makes any real balance worth fewer than the alert floor.
  ["float-low", "RELAYER FLOAT LOW", (q) => ({ ...q, feeWei: "1000000000000000" })],
  [
    "over-report",
    "RELAYER OVER-REPORTS ITS FLOAT",
    (q) => ({ ...q, floatWei: "999000000000000000000" }),
  ],
];

const wanted = process.argv[2] ?? null;
const chosen = wanted ? MUTANTS.filter(([name]) => name === wanted) : MUTANTS;
if (chosen.length === 0) {
  console.error(`No mutant named ${wanted}. Known: ${MUTANTS.map(([n]) => n).join(", ")}`);
  process.exit(2);
}

// Deliberately not spawnSync. The stub relayer lives in this process, and a
// synchronous child blocks the event loop that would have served it — so the
// watcher's fetch hangs until it times out and every mutant looks like
// "relayer not answering". That failure is quiet and convincing, which is
// exactly the kind this tree exists to avoid.
function runWatcher() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WATCHER, "--network", NET], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// A finally does not run when the process is killed, and a harness that leaves
// src/networks.ts pointed at a loopback stub is worse than one that never ran.
const restore = () => writeFileSync(NETWORKS, original);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore();
    console.error(`\n${sig} — src/networks.ts restored.`);
    process.exit(2);
  });
}

let pass = 0;
let fail = 0;
try {
  // Control. If the unmutated watcher already alarms, every result below is
  // meaningless, and the run says so instead of reporting seven passes.
  const control = await runWatcher();
  if (control.code !== 0) {
    console.error("The watcher alarms before any mutation was applied. Nothing below would mean anything.");
    console.error(control.out);
    process.exit(2);
  }
  console.log(`${"MUTANT".padEnd(14)} ${"RESULT".padEnd(8)} ALARM`);
  console.log("-".repeat(72));

  for (const [name, alarm, shape] of chosen) {
    let handle = null;
    let url = "http://127.0.0.1:1"; // a closed port, for relay-down
    if (shape) {
      handle = await stub(shape);
      url = `http://127.0.0.1:${handle.port}`;
    }
    writeFileSync(NETWORKS, original.replace(TESTNET_RELAY, JSON.stringify(url)));
    const { code, out } = await runWatcher();
    handle?.server.close();

    const caught = out.includes(alarm) && code === 1;
    if (caught) pass += 1;
    else fail += 1;
    console.log(`${name.padEnd(14)} ${(caught ? "caught" : "SURVIVED").padEnd(8)} ${alarm}`);
    if (!caught) {
      console.log(`  exit ${code}, and the alarm above never appeared:`);
      for (const line of out.trim().split("\n")) console.log(`    ${line}`);
    }
  }
} finally {
  writeFileSync(NETWORKS, original);
  const restored = readFileSync(NETWORKS, "utf8") === original;
  if (!restored) {
    console.error(`\nsrc/networks.ts was NOT restored. Fix it before committing: git checkout src/networks.ts`);
    process.exit(2);
  }
}

console.log("-".repeat(72));
console.log(`${pass} caught, ${fail} survived. src/networks.ts restored.`);
process.exit(fail > 0 ? 1 : 0);
