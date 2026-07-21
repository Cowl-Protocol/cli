// Testnet faucets, keyed by network. The official Robinhood faucet is
// geo-restricted in some regions, so globally-reachable third-party faucets are
// listed alongside it and marked when a region block is likely.
export type Faucet = { name: string; url: string; note?: string };

export const FAUCETS: Record<string, Faucet[]> = {
  "robinhood-testnet": [
    {
      name: "Robinhood Chain (official)",
      url: "https://faucet.testnet.chain.robinhood.com",
      note: "0.01 ETH/day + stock tokens · geo-restricted in some regions",
    },
    { name: "Chainlink", url: "https://faucets.chain.link/robinhood-testnet" },
    { name: "thirdweb", url: "https://thirdweb.com/robinhood-chain-testnet" },
    { name: "Alchemy", url: "https://www.alchemy.com/rpc/robinhood-testnet" },
  ],
  "arbitrum-sepolia": [
    { name: "Chainlink", url: "https://faucets.chain.link/arbitrum-sepolia" },
    { name: "Alchemy", url: "https://www.alchemy.com/faucets/arbitrum-sepolia" },
  ],
};
