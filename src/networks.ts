import type { Chain } from "viem";

export type CowlContracts = {
  /** Shielded pool contract — deposits, private trades, withdrawals. */
  pool?: `0x${string}`;
  /**
   * Block the pool was deployed in. Commitments live in the event log rather than
   * contract storage, so rebuilding the tree means replaying NoteCommitted — and
   * without a floor that replay starts at genesis, which public RPCs refuse.
   */
  poolDeployBlock?: bigint;
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
    // STALE — redeploy before using. This instance predates both the event change
    // (NoteCommitted lost token+value, so its topic hash moved and this client
    // decodes zero leaves while the contract reports 2) and the on-chain root, so
    // its constructor takes one verifier where the current pool takes two.
    //
    // Both verifiers must be new as well: the shield circuit now proves its own
    // insertion, so the deployed ShieldVerifier holds a verifying key for a
    // circuit that no longer exists. Deploy everything fresh, then put the new
    // address and the printed deployBlock here:
    //
    //   forge script script/Deploy.s.sol \
    //     --rpc-url https://46630.rpc.thirdweb.com --account cowl-deployer --broadcast
    //
    // The two smoke-test leaves on the old pool are not worth migrating.
    contracts: { pool: "0x5DE68a552cf7CcE72d4CC7C1918278B42171809b", poolDeployBlock: 92184357n },
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
