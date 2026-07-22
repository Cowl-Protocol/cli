// Client for the on-chain ShieldedPool.
//
// The contract holds a root but no tree — commitments are an append-only event
// log, and every client rebuilds the depth-20 Merkle tree from NoteCommitted
// locally. The root exists so a spend can prove membership; the tree itself stays
// off chain because the circuits, not Solidity, do the Poseidon2 hashing.
//
// One consequence shapes every write here: a proof is built against a specific
// root, so it is only valid while that root is current. Sync immediately before
// proving, and treat a revert as "someone deposited first" rather than a bug.
import { decodeEventLog } from "viem";
import type { Address, Hash, PrivateKeyAccount, TransactionReceipt } from "viem";
import { publicClient, walletClient } from "../chain.js";
import { toViemChain, type NetworkDef } from "../networks.js";
import type { ShieldProof } from "./prove.js";

export const SHIELDED_POOL_ABI = [
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "newRoot", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "nextLeafIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "root", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "knownRoot", stateMutability: "view", inputs: [{ name: "r", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "committed", stateMutability: "view", inputs: [{ name: "c", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nullifierSpent", stateMutability: "view", inputs: [{ name: "n", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "shieldVerifier", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "transferVerifier", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "NoteCommitted",
    inputs: [
      { name: "commitment", type: "bytes32", indexed: true },
      { name: "leafIndex", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Nullified",
    inputs: [{ name: "nullifier", type: "bytes32", indexed: true }],
  },
] as const;

/** The pool address for this network, or null when it has not been deployed there. */
export function poolAddress(net: NetworkDef): Address | null {
  return net.contracts.pool ?? null;
}

export type ShieldReceipt = {
  hash: Hash;
  /** Leaf index the CONTRACT assigned — authoritative, not the local guess. */
  leafIndex: number;
  commitment: `0x${string}`;
  gasUsed: bigint;
  blockNumber: bigint;
};

/**
 * Submit a shield deposit and read the assigned leaf index back out of the receipt.
 * Native deposits carry `value` as msg.value; ERC-20 deposits need an allowance
 * first, so callers must have approved the pool.
 */
export async function submitShield(
  net: NetworkDef,
  account: PrivateKeyAccount,
  args: {
    token: bigint;
    value: bigint;
    commitment: `0x${string}`;
    /** Root the tree reaches once this note is appended — proven, not asserted. */
    newRoot: `0x${string}`;
    proof: ShieldProof;
  },
): Promise<ShieldReceipt> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  const wallet = walletClient(net, account);
  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "shield",
    args: [args.token, args.value, args.commitment, args.newRoot, args.proof.proof],
    value: args.token === 0n ? args.value : 0n,
  });

  const receipt = await publicClient(net).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Shield transaction reverted (${hash}).`);

  const committed = readNoteCommitted(receipt, pool);
  if (!committed) throw new Error(`Shield landed but emitted no NoteCommitted event (${hash}).`);

  return {
    hash,
    leafIndex: committed.leafIndex,
    commitment: committed.commitment,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

export type ChainLeaves = {
  /** NoteCommitted leaves seen from `fromBlock` on, in leaf-index order. */
  leaves: { index: number; commitment: `0x${string}` }[];
  /** The contract's own leaf count — the yardstick a sync checks itself against. */
  totalLeaves: number;
  /**
   * The contract's own root. A stronger check than the leaf count: it catches a
   * local log that has the right number of leaves in the wrong order, or one
   * corrupted leaf, neither of which the count can see.
   */
  root: `0x${string}`;
  /** Block the log was read through; the next sync's cursor starts after it. */
  latestBlock: bigint;
};

/**
 * Read NoteCommitted leaves from `fromBlock` through the current head. The contract
 * keeps no tree — the event log IS the pool's history — so this is how the local
 * tree learns about every deposit, ours or anyone's. The head is pinned before the
 * log query so the cursor can never step past events that land mid-read.
 */
export async function fetchLeaves(net: NetworkDef, fromBlock: bigint): Promise<ChainLeaves> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  const pub = publicClient(net);

  const latestBlock = await pub.getBlockNumber();
  const logs = fromBlock > latestBlock ? [] : await eventsChunked(pub, pool, fromBlock, latestBlock);

  const leaves: ChainLeaves["leaves"] = [];
  for (const log of logs) {
    const { commitment, leafIndex } = log.args;
    if (commitment === undefined || leafIndex === undefined) continue;
    leaves.push({ index: Number(leafIndex), commitment });
  }
  leaves.sort((a, b) => a.index - b.index);

  // Read both at the same block the log was read through — a deposit landing
  // between the queries must not look like a hole in our log.
  const [totalLeaves, root] = await Promise.all([
    pub.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "nextLeafIndex",
      blockNumber: latestBlock,
    }),
    pub.readContract({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      functionName: "root",
      blockNumber: latestBlock,
    }),
  ]);
  return { leaves, totalLeaves: Number(totalLeaves), root, latestBlock };
}

/**
 * getContractEvents that survives providers capping how many blocks one
 * eth_getLogs may span. The caps and the wording differ per provider — thirdweb
 * alone has answered both "Request exceeds defined limit" and "Log response size
 * exceeded. Maximum allowed number of requested blocks is 1000" — so on rejection
 * the cap is parsed out of the message when the provider names it, and the range
 * is refetched in cap-sized windows. Windows go out in small concurrent groups:
 * the batched transport folds each group into one HTTP request, so a cold replay
 * over tens of thousands of blocks is a handful of roundtrips, not a sequential
 * crawl. Blind halving is only the fallback for providers that keep the cap to
 * themselves.
 */
async function eventsChunked(
  pub: ReturnType<typeof publicClient>,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ args: { commitment?: `0x${string}`; leafIndex?: number } }[]> {
  try {
    return await pub.getContractEvents({
      address: pool,
      abi: SHIELDED_POOL_ABI,
      eventName: "NoteCommitted",
      fromBlock,
      toBlock,
    });
  } catch (e) {
    const msg = (e as Error).message;
    const named = /(?:blocks?\D{0,20}|is )(\d{2,8})(?:\s*blocks?)?/i.exec(msg);
    const rangeError = /limit|range|exceed|too (?:many|large|broad)/i.test(msg);
    if (!rangeError || toBlock <= fromBlock) throw e;

    const span = toBlock - fromBlock + 1n;
    let cap = named ? BigInt(named[1]!) : span / 2n;
    if (cap < 1n || cap >= span) cap = span / 2n;

    const windows: [bigint, bigint][] = [];
    for (let start = fromBlock; start <= toBlock; start += cap) {
      const end = start + cap - 1n < toBlock ? start + cap - 1n : toBlock;
      windows.push([start, end]);
    }

    const out: { args: { commitment?: `0x${string}`; leafIndex?: number } }[] = [];
    const GROUP = 6; // per roundtrip, small enough to stay under rate limits
    for (let i = 0; i < windows.length; i += GROUP) {
      const group = windows.slice(i, i + GROUP);
      const results = await Promise.all(group.map(([a, b]) => eventsChunked(pub, pool, a, b)));
      for (const r of results) out.push(...r);
    }
    return out;
  }
}

/** Pull the NoteCommitted event out of a receipt, ignoring unrelated logs. */
function readNoteCommitted(
  receipt: TransactionReceipt,
  pool: Address,
): { commitment: `0x${string}`; leafIndex: number } | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: SHIELDED_POOL_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "NoteCommitted") continue;
      return {
        commitment: decoded.args.commitment,
        leafIndex: Number(decoded.args.leafIndex),
      };
    } catch {
      // Not one of ours — a token transfer log on the ERC-20 path, say.
    }
  }
  return null;
}

/**
 * Approve the pool to pull an ERC-20 deposit. Native deposits never need this.
 * Approves exactly `value` rather than an unlimited allowance: a shielded pool
 * holding an infinite approval on every user's tokens is a standing liability.
 */
export async function approvePool(
  net: NetworkDef,
  account: PrivateKeyAccount,
  token: Address,
  value: bigint,
): Promise<Hash | null> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  const pub = publicClient(net);
  const current = await pub.readContract({
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: "allowance",
    args: [account.address, pool],
  });
  if (current >= value) return null;

  const wallet = walletClient(net, account);
  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: token,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [pool, value],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
