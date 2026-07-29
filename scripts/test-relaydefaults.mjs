// The relayer defaults, checked against the shipping network table and the live
// daemons. This exists because a network shipped for two days with a pool and no
// `defaultRelay`: every mainnet spend quietly went out from the user's own wallet
// while the plan still called itself private. Nothing failed, so nothing said so.
//
// Static half: any network holding a pool must name a relayer and a trade gas
// figure. Live half: each named relayer must answer for the chain and the pool it
// is supposed to be serving, and quote a trade in proportion to that figure.
//
//   node scripts/test-relaydefaults.mjs
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const TMP = join(CLI, ".test-tmp-relay");

mkdirSync(TMP, { recursive: true });
const out = join(TMP, "networks.mjs");
await esbuild.build({
  entryPoints: [join(CLI, "src/networks.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
});
const { NETWORKS } = await import(out);

let failed = 0;
function ok(label, cond, detail = "") {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failed += 1;
    console.error(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const withPool = Object.values(NETWORKS).filter((n) => n.contracts.pool);
ok("some network has a pool", withPool.length > 0);

// A pool with no relayer is the bug this file was written for. `resolveRelay`
// falls back to `undefined`, spends go out self-paid, and the only symptom is a
// wallet address on the explorer that was never supposed to be there.
for (const net of withPool) {
  ok(`${net.key} names a default relayer`, typeof net.defaultRelay === "string" && net.defaultRelay.length > 0);
  ok(`${net.key} states its trade gas`, typeof net.tradeGas === "bigint" && net.tradeGas > 0n);
}

// A trade adapter without a trade gas figure would quote off the fallback, which
// is the slowest network's number — safe, but silently expensive.
for (const net of Object.values(NETWORKS)) {
  if (net.contracts.tradeAdapter) {
    ok(`${net.key} sizes its adapter's gas`, typeof net.tradeGas === "bigint");
  }
}

// Live half. The relayer named in the table has to be the one actually serving
// that chain's pool: a testnet URL left on a mainnet entry would pass every
// static check above and then quote against the wrong chain entirely.
//
// `--static` skips it, which is how CI runs this file. The static half is a
// property of the source and belongs on every push; the live half depends on two
// daemons being reachable, and a gate that goes red because a VPS blinked is a
// gate everyone learns to ignore. The live half still runs by hand, and by
// itself it is the only thing that catches a daemon left on an older build.
const STATIC_ONLY = process.argv.includes("--static");
if (STATIC_ONLY) console.log("\n  ·   live relayer checks skipped (--static)");
for (const net of STATIC_ONLY ? [] : withPool) {
  const url = `${net.defaultRelay.replace(/\/$/, "")}/quote`;
  let spend, trade;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    spend = await res.json();
    const tres = await fetch(`${url}?op=trade`, { signal: AbortSignal.timeout(15_000) });
    if (!tres.ok) throw new Error(`HTTP ${tres.status} on trade`);
    trade = await tres.json();
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${net.key} relayer answers at ${url}\n      ${e.message}`);
    continue;
  }
  ok(`${net.key} relayer serves chain ${net.chainId}`, spend.chainId === net.chainId, `got ${spend.chainId}`);
  ok(
    `${net.key} relayer serves the configured pool`,
    spend.pool?.toLowerCase() === net.contracts.pool.toLowerCase(),
    `got ${spend.pool}`,
  );

  // The two quotes come from one gas price and one margin, so both cancel in
  // their ratio and what is left is the ratio of the daemon's own gas constants.
  // That is how a daemon still running an older build shows up here without
  // reading its source or trusting what was last deployed. Loose bounds, because
  // the two calls can straddle a gas-price move.
  const SPEND = 4_450_000;
  const want = Number(net.tradeGas) / SPEND;
  const got = Number(BigInt(trade.feeWei)) / Number(BigInt(spend.feeWei));
  ok(
    `${net.key} quotes a trade at ~${want.toFixed(2)}x a spend`,
    got > want * 0.9 && got < want * 1.1,
    `got ${got.toFixed(3)}x, so the daemon is pricing a trade at ${(got * SPEND).toLocaleString()} gas ` +
      `against this table's ${Number(net.tradeGas).toLocaleString()} — redeploy it, or its spend constant has drifted too`,
  );
}

rmSync(TMP, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\nall green");
