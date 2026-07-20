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

// Robinhood Chain is an Arbitrum-based L2. Its public testnet (chainId 46630) went
// live Feb 2026 and mainnet (chainId 4663) on Jul 1 2026, so Cowl targets the real
// Robinhood Chain testnet by default. The official RPC
// (https://rpc.testnet.chain.robinhood.com/rpc) is not reachable from every region,
// so the default uses a globally-reachable public endpoint; swap it any time with
// `cowl config set rpcUrl <url>`. Arbitrum Sepolia stays available as a fallback.
export const NETWORKS: Record<string, NetworkDef> = {
  "robinhood-testnet": {
    key: "robinhood-testnet",
    label: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://46630.rpc.thirdweb.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    contracts: {},
  },
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: false,
    contracts: {},
  },
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
};

export const DEFAULT_NETWORK = "robinhood-testnet";

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
