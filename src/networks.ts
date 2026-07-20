import type { Chain } from "viem";

export type CowlContracts = {
  /** Shielded pool contract — deposits, private trades, withdrawals. */
  pool?: `0x${string}`;
  /** Gasless relayer entrypoint. */
  relayer?: `0x${string}`;
  /** $COWL staking contract. */
  staking?: `0x${string}`;
};

export type NetworkDef = {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  currency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
  contracts: CowlContracts;
};

// Robinhood Chain is an Arbitrum-based L2. Until its public testnet details ship,
// Arbitrum Sepolia is the working default so reads and connectivity are real today.
// Override any RPC or contract address via `cowl config set`.
export const NETWORKS: Record<string, NetworkDef> = {
  "arbitrum-sepolia": {
    key: "arbitrum-sepolia",
    label: "Arbitrum Sepolia",
    chainId: 421614,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    contracts: {},
  },
  "robinhood-testnet": {
    key: "robinhood-testnet",
    label: "Robinhood Chain Testnet",
    chainId: 0, // set once public: `cowl config set network.chainId <id>`
    rpcUrl: "", // set once public: `cowl config set network.rpcUrl <url>`
    explorer: "",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    contracts: {},
  },
};

export const DEFAULT_NETWORK = "arbitrum-sepolia";

/** Build a viem Chain object from a network definition. */
export function toViemChain(net: NetworkDef): Chain {
  return {
    id: net.chainId,
    name: net.label,
    nativeCurrency: net.currency,
    rpcUrls: { default: { http: [net.rpcUrl] } },
    ...(net.explorer
      ? { blockExplorers: { default: { name: net.label, url: net.explorer } } }
      : {}),
    testnet: net.testnet,
  };
}
