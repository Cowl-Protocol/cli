import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "viem";
import type { PublicClient, WalletClient, PrivateKeyAccount, Address, Hash } from "viem";
import { toViemChain, type NetworkDef } from "./networks.js";

export function publicClient(net: NetworkDef): PublicClient {
  if (!net.rpcUrl) {
    throw new Error(
      `No RPC URL for "${net.key}". Set one: cowl config set rpcUrl <url>`,
    );
  }
  return createPublicClient({ chain: toViemChain(net), transport: http(net.rpcUrl) });
}

export function walletClient(net: NetworkDef, account: PrivateKeyAccount): WalletClient {
  if (!net.rpcUrl) {
    throw new Error(`No RPC URL for "${net.key}". Set one: cowl config set rpcUrl <url>`);
  }
  return createWalletClient({ account, chain: toViemChain(net), transport: http(net.rpcUrl) });
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
