// Unit tests for the denomination ladder — the pure math behind default-tiered
// shields and unshields. Bundles the shipping module (same pattern as
// circuits/fixtures.mjs) so what's tested is what runs.
//
//   npm test
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const TMP = join(CLI, ".test-tmp");

mkdirSync(TMP, { recursive: true });
const out = join(TMP, "denominations.mjs");
await esbuild.build({
  entryPoints: [join(CLI, "src/shielded/denominations.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
});
const { tiersFor, decompose, groupParts, sharedCeiling, MAX_BOUNDARY_TXS } = await import(out);

let failed = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const w = JSON.stringify(want, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (g === w) console.log(`  ok  ${label}`);
  else {
    failed += 1;
    console.error(`FAIL  ${label}\n      got  ${g}\n      want ${w}`);
  }
}

const E = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n; // ether → wei, test-only

// The ladder: 1,000,000 down to 0.001 whole tokens, largest first.
const decade = (from, to) => {
  const out = [];
  for (let e = from; e >= to; e--) out.push(10n ** BigInt(e));
  return out;
};
eq("tiersFor(18)", tiersFor(18), decade(24, 15));
// USDC-like 6 decimals: the same ladder, shifted to its base units.
eq("tiersFor(6)", tiersFor(6), decade(12, 3));
// Degenerate low-decimals token never emits a sub-base-unit tier.
eq("tiersFor(2)", tiersFor(2), decade(8, 0));

// The ladder has to reach a million-supply token, or its holders cannot cross
// the boundary in shared denominations at all: at a ten-token top tier this
// amount decomposed into 310,000 deposits, and no rounding could rescue it.
eq("millions split into a handful", decompose(E("3100000"), 18).parts.length, 4);
// And past the ceiling, nothing rounds into range — that is what it is for.
eq("shared ceiling(18)", sharedCeiling(18), 10n ** 24n * BigInt(MAX_BOUNDARY_TXS));
eq(
  "above the ceiling exceeds the cap",
  decompose(sharedCeiling(18) + 10n ** 24n, 18).parts.length > MAX_BOUNDARY_TXS,
  true,
);
eq("at the ceiling fits exactly", decompose(sharedCeiling(18), 18).parts.length, MAX_BOUNDARY_TXS);

// A tier amount is a single part.
eq("0.1 is one deposit", decompose(E("0.1"), 18), { parts: [E("0.1")], remainder: 0n });
// Greedy largest-first split.
eq("0.23 splits clean", decompose(E("0.23"), 18), {
  parts: [E("0.1"), E("0.1"), E("0.01"), E("0.01"), E("0.01")],
  remainder: 0n,
});
eq("25 uses the top tier", decompose(E("25"), 18), {
  parts: [E("10"), E("10"), E("1"), E("1"), E("1"), E("1"), E("1")],
  remainder: 0n,
});
// Below the smallest tier nothing crosses; the amount is all remainder.
eq("0.0005 is all remainder", decompose(E("0.0005"), 18), { parts: [], remainder: E("0.0005") });
// Dust rides along as remainder next to the tier parts.
eq("0.0015 keeps its dust", decompose(E("0.0015"), 18), {
  parts: [E("0.001")],
  remainder: E("0.0005"),
});
// Worst case within one order of magnitude: 9+9+9 parts — the CLI caps this.
eq("0.999 is 27 parts", decompose(E("0.999"), 18).parts.length, 27);
eq("cap is sane", MAX_BOUNDARY_TXS >= 5 && MAX_BOUNDARY_TXS <= 27, true);

// Conservation: parts + remainder always reassemble the value.
for (const raw of ["0.001", "0.042", "1.234567", "9.999999", "123.456"]) {
  const v = E(raw);
  const { parts, remainder } = decompose(v, 18);
  eq(`conserves ${raw}`, parts.reduce((s, p) => s + p, 0n) + remainder, v);
}

// Display grouping keeps order and counts.
eq("groupParts", groupParts([E("0.1"), E("0.1"), E("0.01")]), [
  { tier: E("0.1"), count: 2 },
  { tier: E("0.01"), count: 1 },
]);

rmSync(TMP, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\nall green");
