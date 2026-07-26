import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "viem";
import type { PublicClient, WalletClient, PrivateKeyAccount, Address, Hash } from "viem";
import { toViemChain, type NetworkDef } from "./networks.js";

// One JSON-RPC batch per 16ms window instead of a request per call. Portfolio fires
// half a dozen reads at once (balance + 3 per tracked token), and public RPCs
// rate-limit per request — unbatched, those bursts trip the 429 retry-backoff and a
// portfolio read stretches into tens of seconds.
const TRANSPORT_BATCH = { batch: { wait: 16 } } as const;

/**
 * A provider saying "that block range is too wide" is not a provider failing,
 * and a revert is the chain's answer rather than an endpoint's. Trying the rest
 * of the list on either only spends their timeouts: the next node repeats the
 * revert, and by the time the last one has also declined, the error the caller
 * reads belongs to whichever endpoint happened to be last — so a range cap can
 * no longer be told from an outage, and never gets split.
 */
function surfaceImmediately(error: Error): boolean {
  return (
    /limit|range|exceed|too (?:many|large|broad)/i.test(error.message) ||
    /execution reverted|reverted with|invalid opcode|out of gas|EstimateGas/i.test(error.message)
  );
}

/** The explorer serves the historical log replay nothing else will, and it
 * rate-limits hard, so it waits patiently instead of being raced. */
function isExplorerEndpoint(url: string): boolean {
  return /blockscout|explorer/i.test(url);
}

/** The network's endpoints in preference order, each failing over to the next. */
function transportFor(net: NetworkDef) {
  const urls = [net.rpcUrl, ...(net.rpcFallbacks ?? [])].filter(Boolean);
  if (urls.length === 1) return http(urls[0]!, TRANSPORT_BATCH);
  return fallback(
    urls.map((url) =>
      isExplorerEndpoint(url)
        ? http(url, { ...TRANSPORT_BATCH, timeout: 30_000, retryCount: 3, retryDelay: 3_000 })
        : http(url, { ...TRANSPORT_BATCH, timeout: 8_000, retryCount: 1 }),
    ),
    { shouldThrow: surfaceImmediately },
  );
}

export function publicClient(net: NetworkDef): PublicClient {
  if (!net.rpcUrl) {
    throw new Error(
      `No RPC URL for "${net.key}". Set one: cowl config set rpcUrl <url>`,
    );
  }
  return createPublicClient({ chain: toViemChain(net), transport: transportFor(net) });
}

export function walletClient(net: NetworkDef, account: PrivateKeyAccount): WalletClient {
  if (!net.rpcUrl) {
    throw new Error(`No RPC URL for "${net.key}". Set one: cowl config set rpcUrl <url>`);
  }
  return createWalletClient({ account, chain: toViemChain(net), transport: transportFor(net) });
}

// Minimal ERC-20 ABI (reads + transfer).
export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Send the native coin. Returns the tx hash. */
export async function sendNative(
  net: NetworkDef,
  account: PrivateKeyAccount,
  to: Address,
  amount: string,
): Promise<Hash> {
  const wallet = walletClient(net, account);
  return wallet.sendTransaction({
    account,
    chain: toViemChain(net),
    to,
    value: parseEther(amount),
  });
}

/** Send an ERC-20 token. Returns the tx hash. */
export async function sendToken(
  net: NetworkDef,
  account: PrivateKeyAccount,
  token: Address,
  to: Address,
  amount: string,
): Promise<Hash> {
  const pub = publicClient(net);
  const decimals = await pub.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  const wallet = walletClient(net, account);
  return wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: token,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, parseUnits(amount, decimals)],
  });
}

export async function waitForReceipt(net: NetworkDef, hash: Hash) {
  const pub = publicClient(net);
  return pub.waitForTransactionReceipt({ hash });
}

export async function nativeBalance(net: NetworkDef, address: Address): Promise<string> {
  const client = publicClient(net);
  const wei = await client.getBalance({ address });
  return formatEther(wei);
}

/** ERC-20 metadata only, for listing tokens without needing a holder. */
export async function tokenMeta(
  net: NetworkDef,
  token: Address,
): Promise<{ symbol: string; decimals: number }> {
  const client = publicClient(net);
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  return { decimals, symbol };
}

/** Full ERC-20 read: raw balance plus the metadata needed to value it. */
export async function tokenInfo(
  net: NetworkDef,
  token: Address,
  address: Address,
): Promise<{ raw: bigint; decimals: number; symbol: string }> {
  const client = publicClient(net);
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  return { raw, decimals, symbol };
}

export async function tokenBalance(
  net: NetworkDef,
  token: Address,
  address: Address,
): Promise<{ amount: string; symbol: string }> {
  const client = publicClient(net);
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  return { amount: formatUnits(raw, decimals), symbol };
}
