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
import type { ShieldProof, SpendStruct } from "./prove.js";

export const SHIELDED_POOL_ABI = [
  // Custom errors, so a revert decodes to its name instead of a raw selector —
  // a relayer's rejection message is only as good as this list.
  { type: "error", name: "DuplicateCommitment", inputs: [] },
  { type: "error", name: "TreeFull", inputs: [] },
  { type: "error", name: "ZeroValue", inputs: [] },
  { type: "error", name: "NotAField", inputs: [] },
  { type: "error", name: "WrongDeposit", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "UnknownRoot", inputs: [] },
  { type: "error", name: "AlreadySpent", inputs: [] },
  { type: "error", name: "RepeatedNullifier", inputs: [] },
  { type: "error", name: "NoRecipient", inputs: [] },
  { type: "error", name: "BadCipherLength", inputs: [] },
  { type: "error", name: "ExceedsPooledValue", inputs: [] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NoPendingSwap", inputs: [] },
  { type: "error", name: "SwapNotReady", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "commitment", type: "bytes32" },
      { name: "newRoot", type: "bytes32" },
      { name: "ciphertext", type: "bytes" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "spend",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "membershipRoot", type: "bytes32" },
          { name: "nullifiers", type: "bytes32[2]" },
          { name: "commitments", type: "bytes32[2]" },
          { name: "newRoot", type: "bytes32" },
          { name: "token", type: "uint256" },
          { name: "value", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "relayer", type: "address" },
        ],
      },
      { name: "ciphertexts", type: "bytes[2]" },
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
    name: "NoteCipher",
    inputs: [
      { name: "leafIndex", type: "uint32", indexed: false },
      { name: "ciphertext", type: "bytes", indexed: false },
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
    /** The note encrypted to the depositor's own view key, packed to 158 bytes. */
    ciphertext: `0x${string}`;
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
    args: [args.token, args.value, args.commitment, args.newRoot, args.ciphertext, args.proof.proof],
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

export type SpendReceipt = {
  hash: Hash;
  gasUsed: bigint;
  blockNumber: bigint;
  /** Both output leaves the contract assigned, paired to their commitment. */
  outputs: { commitment: `0x${string}`; leafIndex: number }[];
};

/**
 * Dry-run a spend against the pool's current state without paying for it.
 * A relayer runs this before submitting: an invalid proof, a stale root, or a
 * spent nullifier rejects here as a free eth_call instead of a reverted
 * transaction whose gas the relayer would have eaten.
 */
export async function simulateSpend(
  net: NetworkDef,
  from: Address,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<void> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);
  await publicClient(net).simulateContract({
    account: from,
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "spend",
    args: [
      {
        membershipRoot: spend.membershipRoot,
        nullifiers: [spend.nullifiers[0], spend.nullifiers[1]],
        commitments: [spend.commitments[0], spend.commitments[1]],
        newRoot: spend.newRoot,
        token: spend.token,
        value: spend.value,
        fee: spend.fee,
        recipient: fieldToAddress(spend.recipient),
        relayer: fieldToAddress(spend.relayer),
      },
      ciphertexts,
      proof,
    ],
  });
}

/**
 * Submit a join-split spend. The Spend struct and the two ciphertexts come from
 * proveTransfer and the two output notes; on success the contract has nullified
 * the inputs, appended both outputs, and paid out any public leg. Sync before
 * proving — the proof is bound to the current root, so a spend built against a
 * stale root reverts rather than corrupting anything.
 */
export async function submitSpend(
  net: NetworkDef,
  account: PrivateKeyAccount,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<SpendReceipt> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  const wallet = walletClient(net, account);
  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: pool,
    abi: SHIELDED_POOL_ABI,
    functionName: "spend",
    args: [
      {
        membershipRoot: spend.membershipRoot,
        nullifiers: [spend.nullifiers[0], spend.nullifiers[1]],
        commitments: [spend.commitments[0], spend.commitments[1]],
        newRoot: spend.newRoot,
        token: spend.token,
        value: spend.value,
        fee: spend.fee,
        recipient: fieldToAddress(spend.recipient),
        relayer: fieldToAddress(spend.relayer),
      },
      ciphertexts,
      proof,
    ],
  });

  const receipt = await publicClient(net).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Spend transaction reverted (${hash}).`);

  return {
    hash,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    outputs: readAllNoteCommitted(receipt, pool),
  };
}

/** A field-encoded address, the way the proof carries it, back to a 20-byte address. */
function fieldToAddress(x: bigint): Address {
  return `0x${x.toString(16).padStart(40, "0")}` as Address;
}

export type ChainLeaf = { index: number; commitment: `0x${string}`; cipher?: `0x${string}` };
export type ChainLeaves = {
  /** NoteCommitted leaves from `fromBlock` on, in leaf-index order, each with its NoteCipher if one was emitted. */
  leaves: ChainLeaf[];
  /** Nullifiers seen in the same range — Nullified events, the spent set rebuilt from the chain. */
  nullifiers: `0x${string}`[];
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
  const logs = fromBlock > latestBlock ? [] : await fetchPoolEvents(pub, pool, fromBlock, latestBlock);

  // One log query returns every pool event; partition it into leaves, their
  // ciphertexts (paired by leaf index), and nullifiers.
  const leafByIndex = new Map<number, ChainLeaf>();
  const cipherByIndex = new Map<number, `0x${string}`>();
  const nullifiers: `0x${string}`[] = [];
  for (const log of logs) {
    if (log.eventName === "NoteCommitted") {
      const commitment = log.args.commitment as `0x${string}` | undefined;
      const leafIndex = log.args.leafIndex as number | undefined;
      if (commitment === undefined || leafIndex === undefined) continue;
      leafByIndex.set(Number(leafIndex), { index: Number(leafIndex), commitment });
    } else if (log.eventName === "NoteCipher") {
      const leafIndex = log.args.leafIndex as number | undefined;
      const ciphertext = log.args.ciphertext as `0x${string}` | undefined;
      if (leafIndex === undefined || ciphertext === undefined) continue;
      cipherByIndex.set(Number(leafIndex), ciphertext);
    } else if (log.eventName === "Nullified") {
      const nullifier = log.args.nullifier as `0x${string}` | undefined;
      if (nullifier !== undefined) nullifiers.push(nullifier);
    }
  }
  const leaves: ChainLeaf[] = [...leafByIndex.values()]
    .map((l) => ({ ...l, cipher: cipherByIndex.get(l.index) }))
    .sort((a, b) => a.index - b.index);

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
  return { leaves, nullifiers, totalLeaves: Number(totalLeaves), root, latestBlock };
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
type PoolLog = { eventName: string; args: Record<string, unknown> };

async function fetchPoolEvents(
  pub: ReturnType<typeof publicClient>,
  pool: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PoolLog[]> {
  try {
    const logs = await pub.getContractEvents({ address: pool, abi: SHIELDED_POOL_ABI, fromBlock, toBlock });
    return logs as unknown as PoolLog[];
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

    const out: PoolLog[] = [];
    const GROUP = 6; // per roundtrip, small enough to stay under rate limits
    for (let i = 0; i < windows.length; i += GROUP) {
      const group = windows.slice(i, i + GROUP);
      const results = await Promise.all(group.map(([a, b]) => fetchPoolEvents(pub, pool, a, b)));
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

/** Every NoteCommitted in a receipt, in log order — a spend emits two. */
function readAllNoteCommitted(
  receipt: TransactionReceipt,
  pool: Address,
): { commitment: `0x${string}`; leafIndex: number }[] {
  const out: { commitment: `0x${string}`; leafIndex: number }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: SHIELDED_POOL_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "NoteCommitted") continue;
      out.push({ commitment: decoded.args.commitment, leafIndex: Number(decoded.args.leafIndex) });
    } catch {
      // Not one of ours.
    }
  }
  return out;
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

// ---- trade adapter ----------------------------------------------------------

const SPEND_COMPONENTS = [
  { name: "membershipRoot", type: "bytes32" },
  { name: "nullifiers", type: "bytes32[2]" },
  { name: "commitments", type: "bytes32[2]" },
  { name: "newRoot", type: "bytes32" },
  { name: "token", type: "uint256" },
  { name: "value", type: "uint256" },
  { name: "fee", type: "uint256" },
  { name: "recipient", type: "address" },
  { name: "relayer", type: "address" },
] as const;

export const TRADE_ADAPTER_ABI = [
  {
    type: "function",
    name: "trade",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "spend", type: "tuple", components: SPEND_COMPONENTS },
          { name: "spendCiphertexts", type: "bytes[2]" },
          { name: "spendProof", type: "bytes" },
          { name: "tokenOut", type: "uint256" },
          { name: "amountOut", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "shieldCommitment", type: "bytes32" },
          { name: "shieldNewRoot", type: "bytes32" },
          { name: "shieldCiphertext", type: "bytes" },
          { name: "shieldProof", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Everything CowlTradeAdapter.trade takes, client-shaped. */
export type TradeSubmission = {
  spend: SpendStruct;
  spendCiphertexts: [`0x${string}`, `0x${string}`];
  spendProof: `0x${string}`;
  tokenOut: bigint;
  amountOut: bigint;
  poolFee: number;
  shieldCommitment: `0x${string}`;
  shieldNewRoot: `0x${string}`;
  shieldCiphertext: `0x${string}`;
  shieldProof: `0x${string}`;
};

export function adapterAddress(net: NetworkDef): Address | null {
  return net.contracts.tradeAdapter ?? null;
}

/** Ask the venue quoter what an exact output costs, as a free eth_call. */
export async function quoteExactOutput(
  net: NetworkDef,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
): Promise<bigint> {
  const quoter = net.contracts.quoter;
  if (!quoter) throw new Error(`No trade venue on ${net.label}.`);
  const { result } = await publicClient(net).simulateContract({
    address: quoter,
    abi: QUOTER_ABI,
    functionName: "quoteExactOutputSingle",
    args: [{ tokenIn, tokenOut, amount: amountOut, fee: net.contracts.feeTier ?? 3000, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

function tradeArgs(t: TradeSubmission) {
  return [
    {
      spend: {
        membershipRoot: t.spend.membershipRoot,
        nullifiers: [t.spend.nullifiers[0], t.spend.nullifiers[1]] as readonly [`0x${string}`, `0x${string}`],
        commitments: [t.spend.commitments[0], t.spend.commitments[1]] as readonly [`0x${string}`, `0x${string}`],
        newRoot: t.spend.newRoot,
        token: t.spend.token,
        value: t.spend.value,
        fee: t.spend.fee,
        recipient: fieldToAddress(t.spend.recipient),
        relayer: fieldToAddress(t.spend.relayer),
      },
      spendCiphertexts: [t.spendCiphertexts[0], t.spendCiphertexts[1]] as readonly [`0x${string}`, `0x${string}`],
      spendProof: t.spendProof,
      tokenOut: t.tokenOut,
      amountOut: t.amountOut,
      poolFee: t.poolFee,
      shieldCommitment: t.shieldCommitment,
      shieldNewRoot: t.shieldNewRoot,
      shieldCiphertext: t.shieldCiphertext,
      shieldProof: t.shieldProof,
    },
  ] as const;
}

/** Dry-run a trade against current state — free, and how a relayer vets one. */
export async function simulateTrade(net: NetworkDef, from: Address, t: TradeSubmission): Promise<void> {
  const adapter = adapterAddress(net);
  if (!adapter) throw new Error(`No trade adapter deployed on ${net.label}.`);
  await publicClient(net).simulateContract({
    account: from,
    address: adapter,
    abi: TRADE_ADAPTER_ABI,
    functionName: "trade",
    args: tradeArgs(t),
  });
}

/** Submit an atomic private trade through the adapter. */
export async function submitTrade(
  net: NetworkDef,
  account: PrivateKeyAccount,
  t: TradeSubmission,
): Promise<SpendReceipt> {
  const adapter = adapterAddress(net);
  if (!adapter) throw new Error(`No trade adapter deployed on ${net.label}.`);

  const wallet = walletClient(net, account);
  const hash = await wallet.writeContract({
    account,
    chain: toViemChain(net),
    address: adapter,
    abi: TRADE_ADAPTER_ABI,
    functionName: "trade",
    args: tradeArgs(t),
  });

  const receipt = await publicClient(net).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Trade transaction reverted (${hash}).`);
  const pool = poolAddress(net);
  return {
    hash,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    outputs: pool ? readAllNoteCommitted(receipt, pool) : [],
  };
}
