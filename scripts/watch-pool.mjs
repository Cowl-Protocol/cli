// Governance and turnstile watch for the live pools.
//
//   node scripts/watch-pool.mjs                        check every network with a pool
//   node scripts/watch-pool.mjs --network robinhood-mainnet
//   node scripts/watch-pool.mjs --update               re-record the baseline from chain
//   node scripts/watch-pool.mjs --update --token 0x…   add a token to the turnstile watch
//
// Exit codes: 0 clean, 1 something to look at, 2 could not check.
// A watcher that cannot tell "nothing wrong" from "could not tell" is not a
// watcher, so those are deliberately different codes.
//
// ---------------------------------------------------------------------------
// Why this reads state instead of events
//
// The obvious build is a log subscription on VerifierSwapProposed. It is the
// wrong one here. Robinhood's publicnode RPC refuses historical eth_getLogs,
// and the only archive source (the blockscout eth-rpc) rate-limits to roughly
// one request per window — so a log-based watcher on this chain is either
// blind or throttled, and it fails in the direction that stays quiet.
//
// Every fact worth alerting on is readable as current state:
//
//   pendingSwap(kind)  a swap is queued right now, and when it can execute
//   shieldVerifier()   a swap that already executed shows up as a changed address
//   owner()            the key that can start one at all
//   pooledValue(t)     versus the pool's real balance of t
//
// State reads answer "is something wrong now", which is the question, and they
// cost four calls plus one per watched token. Missing the proposal event is
// survivable; missing it AND not noticing the executed swap is not, and this
// catches the second even if it never saw the first.
//
// ---------------------------------------------------------------------------
// What fires
//
// GOVERNANCE  a verifier swap is pending, a verifier changed, or the owner
//             changed. The swap path is the pool's only drain vector: install a
//             verifier that accepts anything and ExceedsPooledValue caps the
//             damage at all of pooledValue, which is everything. The 7-day
//             VERIFIER_SWAP_DELAY is the entire defence, and it is only a
//             defence if somebody is looking during it.
//
// TURNSTILE   pooledValue[t] exceeds the pool's actual balance of t. The pool
//             cannot pay out what it says it holds. Either a drain is running
//             or a fee-on-transfer token was shielded (see
//             audits/static/README.md — the deposit credits face value while
//             delivering less). Both need a human immediately.
//
// The reverse, balance > pooledValue, is normal: tokens sent to the pool by
// plain transfer never entered through shield() and nobody can withdraw them.
// Two already sit there. It is reported, never alerted on.
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createPublicClient, http, fallback, getAddress } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const TMP = join(CLI, ".watch-tmp");
const BASELINE = join(CLI, "audits/monitoring/pool-baseline.json");

const argv = process.argv.slice(2);
const UPDATE = argv.includes("--update");
const ONLY = argv[argv.indexOf("--network") + 1] || null;
const EXTRA_TOKENS = argv.flatMap((a, i) => (argv[i - 1] === "--token" ? [a] : []));

// ---------------------------------------------------------------- the ABI ---
const POOL_ABI = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "shieldVerifier", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "transferVerifier", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  {
    type: "function",
    name: "pendingSwap",
    inputs: [{ type: "uint8" }],
    outputs: [{ name: "verifier", type: "address" }, { name: "executeAfter", type: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pooledValue",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "root", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "nextLeafIndex", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  {
    type: "function",
    name: "VERIFIER_SWAP_DELAY",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
];
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
];

const KIND = { 0: "shield", 1: "transfer" };

// ------------------------------------------------------- load the networks ---
mkdirSync(TMP, { recursive: true });
const bundled = join(TMP, "networks.mjs");
await esbuild.build({
  entryPoints: [join(CLI, "src/networks.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundled,
  logLevel: "error",
});
const { NETWORKS } = await import(bundled);
rmSync(TMP, { recursive: true, force: true });

const targets = Object.values(NETWORKS)
  .filter((n) => n.contracts?.pool)
  .filter((n) => !ONLY || n.key === ONLY);

if (targets.length === 0) {
  console.error(ONLY ? `No network named ${ONLY} holds a pool.` : "No network holds a pool.");
  process.exit(2);
}

// A token address means nothing on a chain it was not deployed to, and adding
// one blind would record a bogus watch entry on every other network.
if (EXTRA_TOKENS.length > 0 && !ONLY) {
  console.error("--token needs --network: a token address only means something on one chain.");
  process.exit(2);
}

// ------------------------------------------------------------------ output ---
let alerts = 0;
let unchecked = 0;
const say = (s = "") => console.log(s);
const alert = (label, detail) => {
  alerts += 1;
  console.log(`  ALERT  ${label}`);
  for (const line of detail) console.log(`         ${line}`);
};
const ok = (label) => console.log(`  ok     ${label}`);
const note = (label) => console.log(`  ·      ${label}`);

function clientFor(net) {
  const urls = [net.rpcUrl, ...(net.rpcFallbacks ?? [])].filter(Boolean);
  return createPublicClient({
    transport: fallback(urls.map((u) => http(u, { timeout: 20_000 })), { rank: false }),
  });
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    console.error(`Baseline at ${BASELINE} is not valid JSON. Re-record it with --update.`);
    process.exit(2);
  }
}

const baseline = loadBaseline();
const recorded = {};

for (const net of targets) {
  say();
  say(`${net.label} (${net.key}, chain ${net.chainId})`);
  say(`  pool ${net.contracts.pool}`);

  const client = clientFor(net);
  const pool = { address: getAddress(net.contracts.pool), abi: POOL_ABI };

  let state;
  try {
    const [owner, shieldVerifier, transferVerifier, pendingShield, pendingTransfer, root, leaves] =
      await Promise.all([
        client.readContract({ ...pool, functionName: "owner" }),
        client.readContract({ ...pool, functionName: "shieldVerifier" }),
        client.readContract({ ...pool, functionName: "transferVerifier" }),
        client.readContract({ ...pool, functionName: "pendingSwap", args: [0] }),
        client.readContract({ ...pool, functionName: "pendingSwap", args: [1] }),
        client.readContract({ ...pool, functionName: "root" }),
        client.readContract({ ...pool, functionName: "nextLeafIndex" }),
      ]);
    state = { owner, shieldVerifier, transferVerifier, pendingShield, pendingTransfer, root, leaves };
  } catch (e) {
    unchecked += 1;
    console.log(`  UNCHECKED  every RPC failed: ${e.shortMessage ?? e.message}`);
    continue;
  }

  const prev = baseline[net.key] ?? null;

  // --------------------------------------------------------- governance ---
  for (const [field, label] of [
    ["owner", "owner"],
    ["shieldVerifier", "shield verifier"],
    ["transferVerifier", "transfer verifier"],
  ]) {
    const now = getAddress(state[field]);
    if (!prev) {
      note(`${label} ${now} (no baseline yet)`);
    } else if (getAddress(prev[field]) !== now) {
      alert(`${label} CHANGED`, [
        `was ${getAddress(prev[field])}`,
        `now ${now}`,
        field === "owner"
          ? "Ownership moved. If this was not you, every other check below is untrustworthy."
          : "A verifier swap has already executed. Proofs are now checked by different code.",
      ]);
    } else {
      ok(`${label} unchanged`);
    }
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  for (const [kind, pending] of [[0, state.pendingShield], [1, state.pendingTransfer]]) {
    const [verifier, executeAfter] = pending;
    if (executeAfter === 0n) {
      ok(`no ${KIND[kind]} verifier swap pending`);
      continue;
    }
    const left = executeAfter - nowSec;
    const when = new Date(Number(executeAfter) * 1000).toISOString();
    alert(`${KIND[kind]} VERIFIER SWAP PENDING`, [
      `proposed verifier ${getAddress(verifier)}`,
      left > 0n
        ? `executable in ${(Number(left) / 3600).toFixed(1)}h, at ${when}`
        : `EXECUTABLE NOW — the delay elapsed at ${when}`,
      "If this was not proposed by you, withdraw before it executes. The",
      "delay exists to give exactly that window and nothing extends it.",
    ]);
  }

  // ---------------------------------------------------------- turnstile ---
  const tokens = [...new Set([...(prev?.tokens ?? ["0x0000000000000000000000000000000000000000"]), ...EXTRA_TOKENS])];
  const recordedTokens = [];
  for (const token of tokens) {
    const asField = BigInt(token);
    let pooled, held, symbol;
    try {
      pooled = await client.readContract({ ...pool, functionName: "pooledValue", args: [asField] });
      if (asField === 0n) {
        held = await client.getBalance({ address: pool.address });
        symbol = net.currency.symbol;
      } else {
        const erc20 = { address: getAddress(token), abi: ERC20_ABI };
        held = await client.readContract({ ...erc20, functionName: "balanceOf", args: [pool.address] });
        symbol = await client.readContract({ ...erc20, functionName: "symbol" }).catch(() => token.slice(0, 10));
      }
    } catch (e) {
      unchecked += 1;
      console.log(`  UNCHECKED  ${token}: ${e.shortMessage ?? e.message}`);
      continue;
    }
    recordedTokens.push(token);

    if (pooled > held) {
      alert(`TURNSTILE SHORT on ${symbol}`, [
        `pooledValue ${pooled}`,
        `balance     ${held}`,
        `short by    ${pooled - held}`,
        "The pool owes more than it holds. A drain in progress or a",
        "fee-on-transfer token. Stop the relayer and check before anything else.",
      ]);
    } else if (pooled === held) {
      ok(`${symbol} turnstile exact (${pooled})`);
    } else {
      note(`${symbol} turnstile covered — pooled ${pooled}, held ${held}, ${held - pooled} unwithdrawable`);
    }
  }

  note(`tree at leaf ${state.leaves}, root ${state.root}`);

  recorded[net.key] = {
    pool: getAddress(net.contracts.pool),
    owner: getAddress(state.owner),
    shieldVerifier: getAddress(state.shieldVerifier),
    transferVerifier: getAddress(state.transferVerifier),
    tokens: recordedTokens,
  };
}

// --------------------------------------------------------------- baseline ---
if (UPDATE) {
  // Only rewrite networks that were actually reachable, so a dead RPC cannot
  // erase a baseline and make the next run look clean.
  const merged = { ...baseline, ...recorded };
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(merged, null, 2)}\n`);
  say();
  say(`Baseline written to ${BASELINE.replace(`${CLI}/`, "")}`);
  say("Commit it. Drift is only detectable against a recorded expectation.");
  process.exit(unchecked > 0 ? 2 : 0);
}

say();
if (alerts > 0) {
  say(`${alerts} alert${alerts === 1 ? "" : "s"}. Read them before doing anything else.`);
  process.exit(1);
}
if (unchecked > 0) {
  say(`Nothing alerting, but ${unchecked} check${unchecked === 1 ? "" : "s"} could not run.`);
  process.exit(2);
}
say("All clear.");
process.exit(0);
