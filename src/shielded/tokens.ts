// Token registry for the shielded pool. Each token is one field element (the id
// carried inside a note): the native coin is 0, everything else is an address.
// Tokenized stocks and USDG use address-shaped sentinels in the local sim; swap
// them for the real Robinhood Chain token addresses once the pool deploys.
export type TokenInfo = { symbol: string; field: bigint; decimals: number };

const LIST: TokenInfo[] = [
  { symbol: "ETH", field: 0n, decimals: 18 },
  { symbol: "USDG", field: BigInt("0x0000000000000000000000000000000000001111"), decimals: 18 },
  { symbol: "TSLA", field: BigInt("0x0000000000000000000000000000000000002222"), decimals: 18 },
  { symbol: "AAPL", field: BigInt("0x0000000000000000000000000000000000003333"), decimals: 18 },
  { symbol: "NVDA", field: BigInt("0x0000000000000000000000000000000000004444"), decimals: 18 },
];

export const TOKENS_BY_SYMBOL = new Map(LIST.map((t) => [t.symbol, t] as const));
export const TOKENS_BY_FIELD = new Map(LIST.map((t) => [t.field, t] as const));

export function symbolField(symbol: string): bigint | null {
  return TOKENS_BY_SYMBOL.get(symbol.toUpperCase())?.field ?? null;
}

export function fieldSymbol(field: bigint): string | null {
  return TOKENS_BY_FIELD.get(field)?.symbol ?? null;
}
