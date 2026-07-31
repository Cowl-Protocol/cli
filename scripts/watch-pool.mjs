// Governance and turnstile watch for the live pools.
//
//   node scripts/watch-pool.mjs                        check every network with a pool
//   node scripts/watch-pool.mjs --network robinhood-mainnet
//   node scripts/watch-pool.mjs --update               re-record the baseline from chain
//   node scripts/watch-pool.mjs --update --token 0x…   add a token to the turnstile watch
//
// Checks governance, the turnstile, and the gasless relayer's float.
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
//
// RELAYER     the gasless relayer is down, is pointed at the wrong chain or
//             pool, changed its payout address, or is running out of gas.
//             Gasless is the default door on every spend surface in both
//             clients, so the relayer's float is a liveness dependency for
//             most of the product — and it empties silently. Nothing about a
//             successful quote says the wallet behind it is nearly out, and
//             the failure arrives as spends that cannot be submitted, for
//             everyone at once.
//
// The float is measured in spends rather than in ether, because ether alone
// answers nothing without the gas price beside it. The divisor is the
// relayer's own `feeWei` from its own quote, so this watcher holds no copy of
// GAS_PER_SPEND to drift out of step with the daemon. That fee carries the
// relayer's margin, which makes the count slightly conservative — the safe
// direction for a low-fuel warning.
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
// indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] — so
// the naive read silently treats the first argument of any run as a network
// name. `--update` on its own, the form this file and the monitoring README
// both document, died on "No network named --update".
const NETWORK_AT = argv.indexOf("--network");
const ONLY = NETWORK_AT >= 0 ? (argv[NETWORK_AT + 1] ?? null) : null;
if (NETWORK_AT >= 0 && (ONLY === null || ONLY.startsWith("--"))) {
  console.error("--network needs a network key after it.");
  process.exit(2);
}
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

// How much fuel counts as low, in spends the relayer can still pay for.
//
// The number has to be actionable rather than tidy: refilling is a human
// sending ether, so the warning is only worth anything if it arrives with time
// to do that. The airdrop's peak was a claim every 27 seconds, which is about
// 130 spends an hour, so 100 spends is roughly half an hour of headroom at the
// busiest rate this pool has ever seen and weeks at an ordinary one. The watch
// line sits far enough above it to be noticed on a routine run instead of
// during an incident.
const FLOAT_ALERT_SPENDS = 100n;
const FLOAT_WATCH_SPENDS = 500n;

// ------------------------------------------------------- load the networks ---
mkdirSync(TMP, { recursive: true });
const bundled = join(TMP, "networks.mjs");
const bundledRelay = join(TMP, "relay.mjs");
const build = (entry, outfile) =>
  esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "error",
  });
await build(join(CLI, "src/networks.ts"), bundled);
// The relayer's own client, rather than a second reading of its wire format.
// A watcher that parsed the quote its own way could pass while the CLI failed.
await build(join(CLI, "src/relayer/client.ts"), bundledRelay);
const { NETWORKS } = await import(bundled);
const { fetchQuote } = await import(bundledRelay);
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

/** Base units to a decimal string. Wei is unreadable at a glance and this line
 *  is meant to be acted on. */
function units(v, decimals) {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / base}${frac ? `.${frac}` : ""}`;
}

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

  // ------------------------------------------------------------ relayer ---
  // Keep whatever was recorded before, so a relayer that cannot be reached
  // during --update does not erase the address drift is measured against.
  let relayerRecord = prev?.relayer ?? null;
  if (!net.defaultRelay) {
    note("no relayer configured on this network");
  } else {
    let quote = null;
    try {
      quote = await fetchQuote(net.defaultRelay);
    } catch (e) {
      // Every chain read above already succeeded from this machine, so a
      // relayer that will not answer is the relayer and not the connection.
      alert("RELAYER NOT ANSWERING", [
        `at ${net.defaultRelay}`,
        `${e.shortMessage ?? e.message}`,
        "Gasless is down for everyone on this network right now. Spends can",
        "still go out self-paid, which is what both clients fall back to.",
      ]);
    }

    if (quote) {
      // The daemon states which deployment it serves. One pointed elsewhere
      // would quote here and submit somewhere else.
      if (Number(quote.chainId) !== net.chainId) {
        alert("RELAYER ON THE WRONG CHAIN", [
          `${net.defaultRelay} answers for chain ${quote.chainId}`,
          `this network is chain ${net.chainId}`,
          "Stop using it until the daemon's network is corrected.",
        ]);
      } else if (getAddress(quote.pool) !== getAddress(net.contracts.pool)) {
        alert("RELAYER ON THE WRONG POOL", [
          `it serves ${getAddress(quote.pool)}`,
          `this network's pool is ${getAddress(net.contracts.pool)}`,
          "Stop using it until the daemon's pool address is corrected.",
        ]);
      } else {
        ok("relayer serves this chain and pool");
      }

      const payout = getAddress(quote.relayer);
      const before = prev?.relayer?.address ? getAddress(prev.relayer.address) : null;
      if (!before) {
        note(`relayer payout ${payout} (no baseline yet)`);
      } else if (before !== payout) {
        alert("RELAYER PAYOUT ADDRESS CHANGED", [
          `was ${before}`,
          `now ${payout}`,
          "Every gasless fee from here goes to the new address, and every",
          "spend is submitted by whoever holds its key. If this was not a",
          "rotation you performed, treat the daemon as compromised.",
        ]);
      } else {
        ok("relayer payout address unchanged");
      }

      // A quote of zero would let every spend through while the float pays for
      // all of them, and nothing in a successful spend would say so.
      if (quote.feeWei === 0n) {
        alert("RELAYER QUOTES A ZERO FEE", [
          `at ${net.defaultRelay}`,
          "It is subsidising every spend out of its own balance, and its fee",
          "arithmetic is the thing to look at first.",
        ]);
      } else {
        let balance;
        try {
          balance = await client.getBalance({ address: payout });
        } catch (e) {
          unchecked += 1;
          console.log(`  UNCHECKED  relayer balance: ${e.shortMessage ?? e.message}`);
        }
        if (balance !== undefined) {
          const spends = balance / quote.feeWei;
          const held = `${units(balance, net.currency.decimals)} ${net.currency.symbol}`;
          if (spends < FLOAT_ALERT_SPENDS) {
            alert("RELAYER FLOAT LOW", [
              `${held} left, about ${spends} more spends at its own quote`,
              `payout address ${payout}`,
              "When it empties, gasless stops for everyone on this network at",
              "once. Top it up, and remember a private trade burns roughly two",
              "spends' worth of gas, so trades stop before sends do.",
            ]);
          } else if (spends < FLOAT_WATCH_SPENDS) {
            note(`relayer float ${held}, about ${spends} spends left (watch)`);
          } else {
            ok(`relayer float ${held}, about ${spends} spends left`);
          }

          // The daemon reports floatWei and spendsLeft in every quote, and the
          // obvious build of this check is to read them. That build would be a
          // control that asks the thing it watches whether it is well. The
          // measurement above is the chain instead, and the self-report is only
          // worth a cross-check: the daemon derives both from the same account
          // it advertises here, so the two can only disagree if the box is not
          // running the code we think it is.
          //
          // Only over-reporting is alarming, and only past a tolerance. The
          // relayer spends gas between the two reads, so it legitimately holds
          // a little less than it said a moment ago.
          let reported = null;
          try {
            const raw = await fetch(`${net.defaultRelay.replace(/\/+$/, "")}/quote`);
            const body = await raw.json();
            if (typeof body?.floatWei === "string" && /^[0-9]+$/.test(body.floatWei)) {
              reported = BigInt(body.floatWei);
            }
          } catch {
            // The measurement already stands without it.
          }
          if (reported === null) {
            note("relayer does not report its own float (older daemon)");
          } else if (reported > balance + quote.feeWei * 5n) {
            alert("RELAYER OVER-REPORTS ITS FLOAT", [
              `it claims ${units(reported, net.currency.decimals)} ${net.currency.symbol}`,
              `the chain shows ${held} at ${payout}`,
              "It is measuring an account other than the one it advertises, or",
              "the box is not running the build we think it is. Check what is",
              "actually deployed before trusting any quote from it.",
            ]);
          } else {
            ok("relayer's own float figure agrees with the chain");
          }
        }
      }

      relayerRecord = { url: net.defaultRelay, address: payout };
    }
  }

  note(`tree at leaf ${state.leaves}, root ${state.root}`);

  recorded[net.key] = {
    pool: getAddress(net.contracts.pool),
    owner: getAddress(state.owner),
    shieldVerifier: getAddress(state.shieldVerifier),
    transferVerifier: getAddress(state.transferVerifier),
    tokens: recordedTokens,
    ...(relayerRecord ? { relayer: relayerRecord } : {}),
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
