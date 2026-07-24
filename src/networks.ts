import type { Chain } from "viem";

export type CowlContracts = {
  /** Shielded pool contract — deposits, private trades, withdrawals. */
  pool?: `0x${string}`;
  /** Trade venue (V3-interface router + quoter) and its tokens, where deployed. */
  weth?: `0x${string}`;
  usdg?: `0x${string}`;
  swapRouter?: `0x${string}`;
  quoter?: `0x${string}`;
  /** The atomic private-trade adapter (unshield → swap → re-shield). */
  tradeAdapter?: `0x${string}`;
  /**
   * The venue's V3 fee tier for WETH↔USDG routing and gas-in-token quotes.
   * Defaults to 3000 (the testnet venue's fixed pool); mainnet's deepest
   * WETH/USDG pool sits at the 500 (0.05%) tier.
   */
  feeTier?: number;
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
  /** Tried when the primary RPC stops answering — public endpoints do. */
  rpcFallback?: string;
  /**
   * Public relayer used by default for boundary spends, so a wallet never
   * surfaces as the gas payer. `--relay <url>` points at a different one and
   * `--self` opts out; the plan and its confirm always show the relayer and its
   * fee before anything signs. Set only where a relayer is actually hosted.
   */
  defaultRelay?: string;
  explorer: string;
  currency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
  contracts: CowlContracts;
};

// Robinhood Chain is an Arbitrum-based L2. Its public testnet (chainId 46630) went
// live Feb 2026 and mainnet (chainId 4663) on Jul 1 2026, so Cowl targets the real
// Robinhood Chain testnet by default. The globally-reachable thirdweb endpoint is the
// primary; the official testnet RPC (no rate limits, but slower from some regions) is
// the fallback for when thirdweb throttles under load. Swap either with
// `cowl config set rpcUrl <url>`. A relayer polls hard, so it should pin the official
// RPC directly instead of relying on the fallback (see deploy/relayer).
export const NETWORKS: Record<string, NetworkDef> = {
  "robinhood-testnet": {
    key: "robinhood-testnet",
    label: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://46630.rpc.thirdweb.com",
    rpcFallback: "https://rpc.testnet.chain.robinhood.com",
    defaultRelay: "https://relay.cowlprotocol.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    // Redeployed 2026-07-23 with the TIER-1 freeze hardening: domain-separated
    // note hashes, a per-token value-conservation cap, chain-id binding on spends,
    // and a timelocked verifier-swap owner. ShieldVerifier 0xB75c5659…0ba9 is
    // reused (its circuit is unchanged); TransferVerifier 0xBA945Bf3…4239 is new.
    // Only the pool address and its deploy block live here; redeploy the pool and
    // the transfer verifier if the transfer circuit changes again.
    contracts: {
      pool: "0xf9F825f2D6d8509c78baaa587694f74672C32A59",
      poolDeployBlock: 92522685n,
      // The testnet trade venue (V3-interface stand-ins), deployed 2026-07-23.
      weth: "0xdC155cafBa4D26790781c12e4B1001F933496Da2",
      usdg: "0xa82762eDA1AF5Ed19B9BD544C121dbcF365526aC",
      swapRouter: "0xbd610c3A708C483a64dC2C92876C2D1a8Ef43b03",
      quoter: "0x5cD1F037A2CB277A7661Ad6c045803BFC428f84B",
      tradeAdapter: "0xD0D74be38C0B99EBa6465e9F512c3F78EE2d1f3B",
    },
  },
  "robinhood-mainnet": {
    key: "robinhood-mainnet",
    label: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    // The official RPC has gone quiet before (observed 2026-07-23); the
    // explorer's JSON-RPC answered throughout, so reads fail over to it.
    rpcFallback: "https://robinhoodchain.blockscout.com/api/eth-rpc",
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: false,
    // Mainnet shielded pool, deployed 2026-07-24 with the TIER-1 hardening
    // (fresh verifiers; chain-id 4663 is bound into every spend proof).
    // ShieldVerifier 0x0D6E2e89…065fC · TransferVerifier 0x18670646…1275E.
    // The venue is the live pons Uniswap V3 stack — its router is a
    // SwapRouter02 (no deadline in the params struct), so the adapter was
    // deployed with router02=true. USDG is the real 6-decimal Global Dollar;
    // the deepest WETH/USDG pool sits at the 0.05% tier (1.1k WETH deep).
    contracts: {
      pool: "0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E",
      poolDeployBlock: 18121312n,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
      quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
      tradeAdapter: "0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98",
      feeTier: 500,
    },
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
