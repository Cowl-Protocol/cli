// The beta ceiling on what one boundary action may be worth, in US dollars.
//
// Mirrored from the app (lib/betaLimits.ts + lib/tokenPrice.ts) so the two
// clients draw the same line: a deposit or private send worth more than the cap
// is refused before anything proves or signs. The pool is immutable and
// enforces no limit of its own — anyone talking to the contract directly walks
// straight past this. What the cap does is shape the clients almost everyone
// actually uses, and keep any one mistake small while the protocol is young.
//
// Withdrawals are deliberately not capped. A limit on the way out would strand
// anyone holding more than the cap, and a safety measure that traps funds is
// the opposite of one.
//
// The price is asked of the chain, not a constant: the venue quoter reads the
// same pools a trade would execute against, across every fee tier, and the
// MEDIAN answer wins — a single stray pool must not set the number (the app
// found NVDA quoted at a two-hundred-and-fiftieth of its value by one stale
// 0.01% pool). The explorer's rate is the fallback for tokens the venue has no
// pool for. A token neither source can price passes uncapped: an unknown price
// is unknown dollars, and a guardrail that guesses at the number it is
// enforcing is worse than one with a known hole in it.
//
// Real dollars only — testnets clear the check by definition.

import { formatUnits } from "viem";
import type { Address } from "viem";
import type { NetworkDef } from "../networks.js";
import { publicClient } from "../chain.js";

/** The most a single deposit or private send may be worth, in US dollars. */
export const BETA_USD_CAP = 200;

const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Mainnet USDG is the real 6-decimal Global Dollar; WETH is 18 like its coin. */
const USDG_DECIMALS = 6;
const WETH_DECIMALS = 18;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One unit of `tokenIn` in `tokenOut`, across fee tiers, median of what answers. */
async function quoteAcrossTiers(
  net: NetworkDef,
  tokenIn: Address,
  tokenOut: Address,
  decimalsIn: number,
  decimalsOut: number,
): Promise<number | null> {
  const quoter = net.contracts.quoter;
  if (!quoter || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

  const results = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const { result } = await publicClient(net).simulateContract({
          address: quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn: 10n ** BigInt(decimalsIn),
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const out = Number(formatUnits(result[0], decimalsOut));
        return isFinite(out) && out > 0 ? out : null;
      } catch {
        return null; // no pool at this tier, or it cannot fill a unit
      }
    }),
  );
  return median(results.filter((r): r is number => r !== null));
}

/** The explorer's own rate for a token, for anything the venue cannot price. */
async function explorerRate(net: NetworkDef, address: Address): Promise<number | null> {
  try {
    const res = await fetch(`${net.explorer}/api/v2/tokens/${address}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { exchange_rate?: string | null };
    const rate = Number(data.exchange_rate);
    return isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/** The explorer's price for the network's own coin. */
async function explorerCoinPrice(net: NetworkDef): Promise<number | null> {
  try {
    const res = await fetch(`${net.explorer}/api/v2/stats`);
    if (!res.ok) return null;
    const data = (await res.json()) as { coin_price?: string | null };
    const price = Number(data.coin_price);
    return isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** USD price of one unit of a shielded token, or null when nothing will say. */
export async function tokenPriceUsd(
  net: NetworkDef,
  tokenField: bigint,
  decimals: number,
): Promise<number | null> {
  const { weth, usdg } = net.contracts;
  const native = tokenField === 0n;
  const addr = native ? null : (`0x${tokenField.toString(16).padStart(40, "0")}` as Address);

  // USDG is the unit everything else is quoted in, so quoting it against
  // itself would be circular; it is a dollar by definition here.
  if (usdg && addr && addr.toLowerCase() === usdg.toLowerCase()) {
    return (await explorerRate(net, usdg)) ?? 1;
  }

  // The native coin has no pool of its own; its wrapper is the same asset.
  const priced = native ? weth : addr;
  if (usdg && priced) {
    const direct = await quoteAcrossTiers(net, priced, usdg, native ? WETH_DECIMALS : decimals, USDG_DECIMALS);
    if (direct !== null) return direct;

    // No dollar pool: route through the wrapper, which does have one.
    if (weth && priced.toLowerCase() !== weth.toLowerCase()) {
      const inWeth = await quoteAcrossTiers(net, priced, weth, decimals, WETH_DECIMALS);
      const wethUsd = await quoteAcrossTiers(net, weth, usdg, WETH_DECIMALS, USDG_DECIMALS);
      if (inWeth !== null && wethUsd !== null) return inWeth * wethUsd;
    }
  }

  if (native) return explorerCoinPrice(net);
  return addr ? explorerRate(net, addr) : null;
}

/**
 * The US-dollar worth of a boundary amount, or null when nothing on chain will
 * say — including on every testnet, where the dollars are not real.
 */
export async function boundaryWorthUsd(
  net: NetworkDef,
  tokenField: bigint,
  value: bigint,
  decimals: number,
): Promise<number | null> {
  if (net.testnet) return null;
  const price = await tokenPriceUsd(net, tokenField, decimals);
  if (price === null || !isFinite(price) || price <= 0) return null;
  const amount = Number(formatUnits(value, decimals));
  if (!isFinite(amount) || amount <= 0) return null;
  return amount * price;
}
