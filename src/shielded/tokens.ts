// Token registry for the shielded pool. Each token is one field element (the id
// carried inside a note): the native coin is 0, everything else is an address.
// Tokenized stocks and USDG use address-shaped sentinels in the local sim; swap
// them for the real Robinhood Chain token addresses once the pool deploys.
export type TokenInfo = { symbol: string; field: bigint; decimals: number };

const sentinel = (n: number) => BigInt("0x" + n.toString(16).padStart(40, "0"));

const LIST: TokenInfo[] = [
  { symbol: "ETH", field: 0n, decimals: 18 },
  { symbol: "USDG", field: sentinel(0x1111), decimals: 18 },
  { symbol: "TSLA", field: sentinel(0x2222), decimals: 18 },
  { symbol: "AAPL", field: sentinel(0x3333), decimals: 18 },
  { symbol: "NVDA", field: sentinel(0x4444), decimals: 18 },
  { symbol: "AMZN", field: sentinel(0x5555), decimals: 18 },
  { symbol: "NFLX", field: sentinel(0x6666), decimals: 18 },
  { symbol: "PLTR", field: sentinel(0x7777), decimals: 18 },
  { symbol: "AMD", field: sentinel(0x8888), decimals: 18 },
];

export const TOKENS_BY_SYMBOL = new Map(LIST.map((t) => [t.symbol, t] as const));
export const TOKENS_BY_FIELD = new Map(LIST.map((t) => [t.field, t] as const));

export function symbolField(symbol: string): bigint | null {
  return TOKENS_BY_SYMBOL.get(symbol.toUpperCase())?.field ?? null;
}

export function fieldSymbol(field: bigint): string | null {
  return TOKENS_BY_FIELD.get(field)?.symbol ?? null;
}
