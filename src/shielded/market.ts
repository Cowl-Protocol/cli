// Markets for private trades. A shielded swap spends a note of the input token
// and mints a note of the output token, so the size and direction never hit the
// public explorer. Pricing here is an indicative quote plus the protocol fee —
// the real routing goes through an on-chain DEX adapter once the pool deploys.
export const WAD = 10n ** 18n;

/** Everything is valued in this token. */
export const QUOTE_SYMBOL = "USDG";

/** Protocol fee on each private trade, in basis points. Mirrors the fee model. */
export const PROTOCOL_FEE_BPS = 10n; // ~0.10%

export type MarketDef = { key: string; base: string; quote: string; priceWad: bigint };

const price = (whole: number) => BigInt(whole) * WAD;

// Every market is quoted in USDG. Prices are placeholders for the local sim; a
// price feed replaces them when the on-chain DEX adapter lands.
const market = (base: string, whole: number): MarketDef => ({
  key: `${base}-${QUOTE_SYMBOL}`,
  base,
  quote: QUOTE_SYMBOL,
  priceWad: price(whole),
});

export const MARKETS: Record<string, MarketDef> = Object.fromEntries(
  [
    market("ETH", 3000),
    market("TSLA", 250),
    market("AMZN", 230),
    market("NFLX", 900),
    market("PLTR", 180),
    market("AMD", 170),
    market("AAPL", 190),
    market("NVDA", 120),
  ].map((m) => [m.key, m]),
);

/** Price of one unit of `symbol` in the quote token, WAD scaled. Null if unpriced. */
export function priceInQuoteWad(symbol: string): bigint | null {
  const up = symbol.toUpperCase();
  if (up === QUOTE_SYMBOL) return WAD;
  return MARKETS[`${up}-${QUOTE_SYMBOL}`]?.priceWad ?? null;
}

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
