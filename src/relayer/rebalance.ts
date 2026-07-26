// Turning the fees a relayer earns back into the gas it spends.
//
// A relayer pays gas in the native coin and is paid in whatever token the spend
// moved. Left alone the two never meet: the float drains on every ERC-20
// withdrawal while the tokens pile up, and a relayer that looks profitable runs
// out of gas anyway. This is the loop that closes it.
//
// It runs on a threshold rather than on every fee, because a swap costs gas of
// its own — sweeping after each spend would spend more than it recovered. When
// the float falls past the mark, everything worth selling is sold at once.
import type { Address, PrivateKeyAccount } from "viem";
import { encodeFunctionData } from "viem";
import type { NetworkDef } from "../networks.js";
import { publicClient, walletClient } from "../chain.js";

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** WETH's own surface: the last hop out of the wrapper and into gas. */
const WETH_ABI = [
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * SwapRouter02 dropped `deadline` from the params struct, which moves the
 * selector — the classic encoding reverts on an 02 router and the reverse is
 * also true. Rather than carry a flag per network that can go stale, both are
 * simulated and whichever answers is the one that gets submitted. A simulation
 * costs nothing, and being wrong here would cost a reverted swap's gas.
 */
const ROUTER02_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const ROUTER_CLASSIC_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Room for the pool to move between quoting and landing, in percent. */
const SLIPPAGE_PCT = 3n;

/** Gas a single-hop swap plus its approval costs, generously. */
const GAS_PER_SWAP = 400_000n;

/**
 * A sale has to be worth its own gas by this multiple before it happens.
 *
 * Selling dust at break-even leaves the float exactly where it was and burns a
 * transaction saying so. Below this the token is left alone until enough of it
 * accumulates to be worth moving.
 */
const WORTH_SELLING = 3n;

export type SweepResult = {
  token: Address;
  symbol: string;
  amountIn: bigint;
  ethOut: bigint;
  hash: `0x${string}`;
};

export type SweepReport = {
  /** Native balance before and after, so the caller can log the difference. */
  floatBefore: bigint;
  floatAfter: bigint;
  sold: SweepResult[];
  /** Tokens held but left alone, with the reason. */
  skipped: { token: Address; symbol: string; reason: string }[];
};

async function symbolOf(net: NetworkDef, token: Address): Promise<string> {
  try {
    return await publicClient(net).readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" });
  } catch {
    return token.slice(0, 10);
  }
}

/** The best price any tier will give for selling `amountIn` of `token`. */
async function bestQuote(
  net: NetworkDef,
  token: Address,
  amountIn: bigint,
): Promise<{ out: bigint; tier: number } | null> {
  const quoter = net.contracts.quoter;
  const weth = net.contracts.weth;
  if (!quoter || !weth) return null;

  const client = publicClient(net);
  const quotes = await Promise.all(
    FEE_TIERS.map(async (tier: number) => {
      try {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: token, tokenOut: weth, amountIn, fee: tier, sqrtPriceLimitX96: 0n }],
        });
        return { out: result[0], tier };
      } catch {
        return null;
      }
    }),
  );
  // Selling, so more WETH out is better — the opposite of pricing a fee.
  let best: { out: bigint; tier: number } | null = null;
  for (const q of quotes) {
    if (!q || q.out <= 0n) continue;
    if (best === null || q.out > best.out) best = q;
  }
  return best;
}

/**
 * Sell one token for WETH, whichever router dialect the venue speaks.
 * Returns the transaction hash, or throws with the venue's own reason.
 */
async function sellForWeth(
  net: NetworkDef,
  account: PrivateKeyAccount,
  token: Address,
  amountIn: bigint,
  minOut: bigint,
  tier: number,
): Promise<`0x${string}`> {
  const router = net.contracts.swapRouter!;
  const weth = net.contracts.weth!;
  const client = publicClient(net);
  const wallet = walletClient(net, account);

  const base = {
    tokenIn: token,
    tokenOut: weth,
    fee: tier,
    recipient: account.address,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  };

  // Try the 02 shape first; the classic one carries a deadline. Each candidate
  // is encoded up front so the simulation and the submission are byte-identical.
  const candidates: `0x${string}`[] = [
    encodeFunctionData({ abi: ROUTER02_ABI, functionName: "exactInputSingle", args: [base] }),
    encodeFunctionData({
      abi: ROUTER_CLASSIC_ABI,
      functionName: "exactInputSingle",
      args: [{ ...base, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }],
    }),
  ];

  let lastError: unknown;
  for (const data of candidates) {
    try {
      await client.call({ account, to: router, data });
      return await wallet.sendTransaction({ account, chain: null, to: router, data });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The venue refused the swap.");
}

/**
 * Sell everything worth selling and unwrap the proceeds into gas.
 *
 * Each token is quoted first and skipped unless the sale clearly beats the gas
 * it would cost, so a sweep never makes the float smaller than it found it.
 * A token that fails is logged and the sweep moves on: one bad pool must not
 * strand the rest of the balance.
 */
export async function sweepToGas(
  net: NetworkDef,
  account: PrivateKeyAccount,
  tokens: Address[],
): Promise<SweepReport> {
  const client = publicClient(net);
  const wallet = walletClient(net, account);
  const weth = net.contracts.weth;
  const router = net.contracts.swapRouter;

  const floatBefore = await client.getBalance({ address: account.address });
  const report: SweepReport = { floatBefore, floatAfter: floatBefore, sold: [], skipped: [] };
  if (!weth || !router || !net.contracts.quoter) {
    report.skipped.push({ token: "0x0" as Address, symbol: "-", reason: "this network has no venue to sell into" });
    return report;
  }

  const gasPrice = await client.getGasPrice();
  const swapCost = gasPrice * GAS_PER_SWAP;

  for (const token of tokens) {
    const symbol = await symbolOf(net, token);
    try {
      const held: bigint = await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (held === 0n) continue;

      const quote = await bestQuote(net, token, held);
      if (!quote) {
        report.skipped.push({ token, symbol, reason: "no pool prices it" });
        continue;
      }
      if (quote.out < swapCost * WORTH_SELLING) {
        report.skipped.push({ token, symbol, reason: "worth less than the gas to sell it" });
        continue;
      }

      const minOut = (quote.out * (100n - SLIPPAGE_PCT)) / 100n;

      const allowance: bigint = await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, router],
      });
      if (allowance < held) {
        const approveHash = await wallet.sendTransaction({
          account,
          chain: null,
          to: token,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [router, held] }),
        });
        await client.waitForTransactionReceipt({ hash: approveHash });
      }

      const hash = await sellForWeth(net, account, token, held, minOut, quote.tier);
      await client.waitForTransactionReceipt({ hash });
      report.sold.push({ token, symbol, amountIn: held, ethOut: quote.out, hash });
    } catch (e) {
      report.skipped.push({ token, symbol, reason: (e as Error).message.split("\n")[0] ?? "sale failed" });
    }
  }

  // Everything sold arrives as WETH. Unwrap it in one go, including any that
  // was already sitting there from an earlier sweep that died mid-flight.
  try {
    const wrapped: bigint = await client.readContract({
      address: weth,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (wrapped > 0n) {
      const hash = await wallet.sendTransaction({
        account,
        chain: null,
        to: weth,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [wrapped] }),
      });
      await client.waitForTransactionReceipt({ hash });
    }
  } catch (e) {
    report.skipped.push({ token: weth, symbol: "WETH", reason: (e as Error).message.split("\n")[0] ?? "unwrap failed" });
  }

  report.floatAfter = await client.getBalance({ address: account.address });
  return report;
}
