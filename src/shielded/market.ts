// Markets for private trades. A shielded swap spends a note of the input token
// and mints a note of the output token, so the size and direction never hit the
// public explorer. Pricing here is an indicative quote plus the protocol fee —
// the real routing goes through an on-chain DEX adapter once the pool deploys.
const WAD = 10n ** 18n;

/** Protocol fee on each private trade, in basis points. Mirrors the fee model. */
export const PROTOCOL_FEE_BPS = 10n; // ~0.10%

export type MarketDef = { key: string; base: string; quote: string; priceWad: bigint };

const price = (whole: number) => BigInt(whole) * WAD;

// Every market is quoted in USDG. Prices are indicative, for the local sim only.
export const MARKETS: Record<string, MarketDef> = {
  "ETH-USDG": { key: "ETH-USDG", base: "ETH", quote: "USDG", priceWad: price(3000) },
  "TSLA-USDG": { key: "TSLA-USDG", base: "TSLA", quote: "USDG", priceWad: price(250) },
  "AAPL-USDG": { key: "AAPL-USDG", base: "AAPL", quote: "USDG", priceWad: price(190) },
  "NVDA-USDG": { key: "NVDA-USDG", base: "NVDA", quote: "USDG", priceWad: price(120) },
};

export type Side = "buy" | "sell";

export type TradeQuote = {
  inputSymbol: string; // token you spend
  outputSymbol: string; // token you receive
  amountIn: bigint; // base units spent
  amountOut: bigint; // base units received
  feeAmount: bigint; // protocol fee, in the quote token
  feeToken: string;
  priceWad: bigint;
};

/**
 * Quote a trade. `amountIn` is always the amount you spend:
 *   sell → spend `amount` of the base, receive the quote
 *   buy  → spend `amount` of the quote, receive the base
 */
export function quoteTrade(marketKey: string, side: Side, amountIn: bigint): TradeQuote {
  const m = MARKETS[marketKey];
  if (!m) throw new Error(`Unknown market "${marketKey}". Known: ${Object.keys(MARKETS).join(", ")}`);

  if (side === "sell") {
    const gross = (amountIn * m.priceWad) / WAD; // in quote
    const fee = (gross * PROTOCOL_FEE_BPS) / 10000n;
    return { inputSymbol: m.base, outputSymbol: m.quote, amountIn, amountOut: gross - fee, feeAmount: fee, feeToken: m.quote, priceWad: m.priceWad };
  }
  // buy
  const fee = (amountIn * PROTOCOL_FEE_BPS) / 10000n;
  const net = amountIn - fee; // quote after fee
  const out = (net * WAD) / m.priceWad; // in base
  return { inputSymbol: m.quote, outputSymbol: m.base, amountIn, amountOut: out, feeAmount: fee, feeToken: m.quote, priceWad: m.priceWad };
}
