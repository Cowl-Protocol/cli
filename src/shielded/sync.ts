// Brings the local shielded pool in step with the chain.
//
// The happy path is cheap: resume the NoteCommitted replay from the stored cursor
// block, append whatever is new, advance the cursor. When the local log turns out
// to disagree with the chain — stale sim-era state, a reorg, a cursor that skipped
// blocks — the incremental pass throws ChainDrift and the whole history is replayed
// once from the deploy block, keeping our ciphertexts by commitment value.
import type { NetworkDef } from "../networks.js";
import { fetchLeaves, poolAddress } from "./contract.js";
import { ChainDrift, alignPoolToChain, applyChainLeaves, loadPool, savePool } from "./pool.js";

export type SyncResult = {
  /** Leaves this sync added to the local log. */
  appended: number;
  totalLeaves: number;
  root: string;
  /** True when drift forced a full replay instead of the incremental pass. */
  resynced: boolean;
};

/**
 * Sync the local pool with the on-chain one. Returns null on networks with no pool
 * contract — the local simulation is the only ledger there, and there is nothing
 * to sync against.
 *
 * Every pass ends by comparing the rebuilt root against the contract's own. That
 * covers the case a leaf count cannot: a prefix that drifted before the cursor,
 * where the log is the right length but not the right tree. A mismatch raises
 * ChainDrift and falls through to a full replay, and `full` forces that replay
 * up front — `cowl scan` uses it.
 */
export async function syncShieldedPool(
  net: NetworkDef,
  opts: { full?: boolean } = {},
): Promise<SyncResult | null> {
  if (!poolAddress(net)) return null;
  const deployBlock = net.contracts.poolDeployBlock ?? 0n;
  const pool = loadPool(net.key);
  const before = pool.commitments.length;

  let resynced = false;
  if (opts.full) {
    resynced = await replayEverything(net, pool, deployBlock);
  } else {
    const from = pool.syncedBlock !== undefined ? BigInt(pool.syncedBlock) + 1n : deployBlock;
    try {
      const chain = await fetchLeaves(net, from);
      applyChainLeaves(pool, chain.leaves, chain.totalLeaves, chain.root);
      pool.syncedBlock = chain.latestBlock.toString();
    } catch (e) {
      if (!(e instanceof ChainDrift)) throw e;
      resynced = true;
      await replayEverything(net, pool, deployBlock);
    }
  }

  savePool(net.key, pool);
  return {
    appended: Math.max(0, pool.commitments.length - before),
    totalLeaves: pool.commitments.length,
    root: pool.root,
    resynced,
  };
}

/**
 * Replace the local log with a complete replay of the chain's. Returns whether the
 * replay actually changed anything — the signal that local state had drifted.
 */
async function replayEverything(net: NetworkDef, pool: ReturnType<typeof loadPool>, deployBlock: bigint): Promise<boolean> {
  const beforeCommitments = pool.commitments.join(",");
  const all = await fetchLeaves(net, deployBlock);
  const commitments: string[] = [];
  for (const leaf of all.leaves) commitments[leaf.index] = leaf.commitment;
  if (commitments.length !== all.totalLeaves || commitments.some((c) => !c)) {
    throw new Error(
      `Pool has ${all.totalLeaves} leaves on chain but the full event replay yielded ${commitments.length}. ` +
        `The RPC may be truncating history — try another with: cowl config set rpcUrl <url>`,
    );
  }
  alignPoolToChain(pool, commitments);
  if (pool.root !== all.root) {
    throw new Error(
      `Replayed ${all.totalLeaves} leaves but reached root ${pool.root}, and the pool reports ${all.root}. ` +
        `The RPC may be serving an incomplete log — try another with: cowl config set rpcUrl <url>`,
    );
  }
  // The chain is the authority on spends too. Rebuilding the spent set means
  // replaying the contract's Nullified events; until the CLI can actually spend,
  // clearing it is both correct and the thing that erases a sim-era nullifier
  // wrongly pinning a real note as spent.
  pool.nullifiers = [];
  pool.syncedBlock = all.latestBlock.toString();
  return pool.commitments.join(",") !== beforeCommitments;
}
