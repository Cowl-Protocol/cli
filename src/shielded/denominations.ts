// Fixed denominations for the pool's boundary — the amounts that cross in and
// out in public.
//
// A deposit's value is calldata and a withdrawal's public leg is calldata, so
// an arbitrary amount is a fingerprint: shield 0.2337 and later withdraw
// 0.2337 and the two ends link themselves, however sound the proofs are
// (subset-sum over public amounts is a proven deanonymization). Amounts that
// travel in shared denominations don't have that edge — every 0.1 looks like
// every other 0.1, and each tier is an anonymity set that grows with use.
//
// Three rules, straight from the privacy roadmap:
//
//   1. Client-side only. The contract forbids nothing — a denomination baked
//      on chain is a regret that can't be patched, and a lonely tier is an
//      anonymity set of one.
//   2. Default, not mandate. Callers pass the exact amount through when asked
//      to (--exact); the default just makes the private choice the easy one.
//   3. Boundary only. Private sends and change notes never surface an amount,
//      so they stay arbitrary — denominating them would buy nothing.
//
// The ladder is powers of ten around one whole token: 0.001 · 0.01 · 0.1 · 1
// · 10. Few tiers on purpose — every extra tier splits the crowd.

/** Tier exponents relative to one whole token (10^decimals base units). */
const TIER_STEPS = [1, 0, -1, -2, -3] as const;

/** Boundary transactions one command may fan out into. Past this the amount
 * wants rounding (or --exact), not a parade of deposits. */
export const MAX_BOUNDARY_TXS = 12;

/** The denomination ladder for a token, largest first, in base units. */
export function tiersFor(decimals: number): bigint[] {
  return TIER_STEPS.map((step) => decimals + step)
    .filter((exp) => exp >= 0)
    .map((exp) => 10n ** BigInt(exp));
}

export type Decomposition = {
  /** Tier-sized amounts, largest first — one boundary transaction each. */
  parts: bigint[];
  /** What's left below the smallest tier. Stays on the side it already sits on. */
  remainder: bigint;
};

/** Greedy largest-first split of `value` into denomination parts. */
export function decompose(value: bigint, decimals: number): Decomposition {
  const parts: bigint[] = [];
  let left = value;
  for (const tier of tiersFor(decimals)) {
    while (left >= tier) {
      parts.push(tier);
      left -= tier;
    }
  }
  return { parts, remainder: left };
}

/** Collapse parts into (tier, count) rows for display, largest first. */
export function groupParts(parts: bigint[]): { tier: bigint; count: number }[] {
  const rows: { tier: bigint; count: number }[] = [];
  for (const part of parts) {
    const last = rows[rows.length - 1];
    if (last && last.tier === part) last.count += 1;
    else rows.push({ tier: part, count: 1 });
  }
  return rows;
}
