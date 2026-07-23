// Shielded-pool state — a faithful, offline simulation of the on-chain pool.
//
// The design separates two things the way the real system does:
//   • the POOL is a shared ledger (commitment tree, nullifier set, broadcast
//     ciphertexts) — on-chain in production, a shared file locally.
//   • a WALLET holds only its owner's discovered notes — private, per-machine.
//
// The core operations are pure functions over (pool, wallet, keys); a thin
// storage layer loads and saves them. Every op is a real join-split: inputs are
// nullified, outputs are fresh commitments, value is conserved. When the pool
// contract deploys, these ops gain a proof and a transaction; the math is unchanged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";
import { COWL_DIR } from "../paths.js";
import { fieldToHex, hexToField, randomField } from "./field.js";
import { type Note, commitment, nullifier, newNote } from "./note.js";
import { computeRoot } from "./tree.js";
import { type NoteCipher, encryptNote, tryDecryptNote, unpackCipher } from "./crypto.js";
import type { ShieldedKeys, PaymentAddress } from "./keys.js";
import type { SpendPlan, SpendOutput } from "./prove.js";

// ---- types ------------------------------------------------------------------

export type Pool = {
  commitments: string[]; // hex, insertion order = leaf index
  nullifiers: string[]; // hex, the spent set
  // One slot per commitment, same index. Null where we hold the commitment but not
  // the note behind it — every leaf someone else deposited on chain, since the pool
  // contract publishes commitments but not the encrypted notes.
  ciphertexts: (NoteCipher | null)[];
  root: string; // current Merkle root (hex)
  // Last block the on-chain NoteCommitted log was replayed through. The next sync
  // resumes here instead of the deploy block, so a balance check costs one small
  // log query, not the pool's whole history. Absent on sim-only networks.
  syncedBlock?: string;
};

export type StoredNote = {
  value: string; // hex
  token: string; // hex
  blinding: string; // hex
  leafIndex: number;
  spent: boolean;
};

/**
 * A note whose deposit has broadcast but not yet been filed against a leaf. Written
 * BEFORE the transaction goes out: if the process dies between the tx landing and
 * the local files updating, the blinding survives here — without it the funds
 * behind the commitment would be unspendable forever.
 */
export type PendingNote = { value: string; token: string; blinding: string; commitment: string };

export type Wallet = { notes: StoredNote[]; pending?: PendingNote[] };

export function emptyPool(): Pool {
  return { commitments: [], nullifiers: [], ciphertexts: [], root: fieldToHex(computeRoot([])) };
}
export function emptyWallet(): Wallet {
  return { notes: [] };
}

// ---- pure core --------------------------------------------------------------

/** Append a commitment + its ciphertext, refresh the root. Returns the leaf index. */
function insert(pool: Pool, c: bigint, cipher: NoteCipher): number {
  const leafIndex = pool.commitments.length;
  pool.commitments.push(fieldToHex(c));
  pool.ciphertexts.push(cipher);
  pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
  return leafIndex;
}

function toStored(n: Note, leafIndex: number): StoredNote {
  return { value: fieldToHex(n.value), token: fieldToHex(n.token), blinding: fieldToHex(n.blinding), leafIndex, spent: false };
}

export type ShieldResult = { leafIndex: number; commitment: string; root: string };

/** Deposit: mint a note to yourself and insert its commitment. */
export function applyShield(pool: Pool, wallet: Wallet, keys: ShieldedKeys, value: bigint, token: bigint): ShieldResult {
  const note = newNote(value, token, keys.mpk);
  const c = commitment(note);
  const leafIndex = insert(pool, c, encryptNote(note, keys.viewPubHex));
  wallet.notes.push(toStored(note, leafIndex));
  return { leafIndex, commitment: fieldToHex(c), root: pool.root };
}

/** Discover notes paid to me and refresh which of my notes are spent. */
export function applyScan(pool: Pool, wallet: Wallet, keys: ShieldedKeys): { discovered: number } {
  // Adopt pending deposits whose commitment has appeared in the log — the recovery
  // path for a shield that broadcast but died before recording locally.
  if (wallet.pending?.length) {
    wallet.pending = wallet.pending.filter((pn) => {
      const idx = pool.commitments.indexOf(pn.commitment);
      if (idx < 0) return true; // not landed yet — keep waiting
      if (!wallet.notes.some((n) => n.leafIndex === idx)) {
        wallet.notes.push({ value: pn.value, token: pn.token, blinding: pn.blinding, leafIndex: idx, spent: false });
      }
      return false;
    });
  }

  const known = new Set(wallet.notes.map((n) => n.leafIndex));
  const nulls = new Set(pool.nullifiers);
  let discovered = 0;

  for (let i = 0; i < pool.ciphertexts.length; i++) {
    if (known.has(i)) continue;
    const cipher = pool.ciphertexts[i];
    if (!cipher) continue; // commitment known, note not published to us
    const dec = tryDecryptNote(cipher, keys.viewPriv);
    if (!dec) continue;
    const note: Note = { value: dec.value, token: dec.token, mpk: keys.mpk, blinding: dec.blinding };
    if (fieldToHex(commitment(note)) !== pool.commitments[i]) continue; // not really ours
    wallet.notes.push(toStored(note, i));
    known.add(i);
    discovered++;
  }

  // Drop notes the pool no longer vouches for: after a chain sync replaced the log,
  // a sim-era note's leaf either does not exist or holds someone else's commitment.
  // Without this they would linger as phantom balance forever.
  wallet.notes = wallet.notes.filter((n) => {
    const at = pool.commitments[n.leafIndex];
    if (!at) return false;
    const note: Note = { value: hexToField(n.value), token: hexToField(n.token), mpk: keys.mpk, blinding: hexToField(n.blinding) };
    return fieldToHex(commitment(note)) === at;
  });

  // Recomputed from the ledger each scan, in both directions: a nullifier appearing
  // marks the note spent, and a nullifier retracted (a sim-era spend cleared by a
  // chain replay) un-marks it. `spent` is a cache of the nullifier set, not a fact
  // of its own.
  for (const n of wallet.notes) {
    n.spent = nulls.has(fieldToHex(nullifier(keys.nk, n.leafIndex)));
  }
  return { discovered };
}

export type Balance = { token: bigint; amount: bigint; notes: number }[];

/** Shielded portfolio: unspent value grouped by token. */
export function computeBalance(wallet: Wallet): Balance {
  const by = new Map<string, { amount: bigint; notes: number }>();
  for (const n of wallet.notes) {
    if (n.spent) continue;
    const cur = by.get(n.token) ?? { amount: 0n, notes: 0 };
    cur.amount += hexToField(n.value);
    cur.notes++;
    by.set(n.token, cur);
  }
  return [...by.entries()].map(([token, v]) => ({ token: hexToField(token), amount: v.amount, notes: v.notes }));
}

/** Pick unspent notes of `token` covering `need`. */
function selectNotes(wallet: Wallet, token: bigint, need: bigint): { notes: StoredNote[]; total: bigint } {
  const picked: StoredNote[] = [];
  let total = 0n;
  for (const n of wallet.notes) {
    if (n.spent || hexToField(n.token) !== token) continue;
    picked.push(n);
    total += hexToField(n.value);
    if (total >= need) break;
  }
  if (total < need) throw new Error(`Insufficient shielded balance: need ${formatEther(need)}, have ${formatEther(total)}.`);
  return { notes: picked, total };
}

function spendInputs(pool: Pool, wallet: Wallet, keys: ShieldedKeys, inputs: StoredNote[]): string[] {
  const nullifiers: string[] = [];
  for (const inp of inputs) {
    const nf = fieldToHex(nullifier(keys.nk, inp.leafIndex));
    pool.nullifiers.push(nf);
    nullifiers.push(nf);
    const mine = wallet.notes.find((n) => n.leafIndex === inp.leafIndex);
    if (mine) mine.spent = true;
  }
  return nullifiers;
}

/** Mint a note to yourself, insert its commitment, and record it. Returns the commitment hex. */
function mintSelfNote(pool: Pool, wallet: Wallet, keys: ShieldedKeys, token: bigint, value: bigint): string {
  const note = newNote(value, token, keys.mpk);
  const c = commitment(note);
  const leafIndex = insert(pool, c, encryptNote(note, keys.viewPubHex));
  wallet.notes.push(toStored(note, leafIndex));
  return fieldToHex(c);
}

export type SpendResult = { nullifiers: string[]; outCommitment?: string; changeCommitment?: string; root: string };

/** Private transfer: spend my notes, mint an output note to the recipient (+ change to me). */
export function applySend(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  recipient: PaymentAddress,
  value: bigint,
  token: bigint,
): SpendResult {
  const { notes: inputs, total } = selectNotes(wallet, token, value);
  const nullifiers = spendInputs(pool, wallet, keys, inputs);

  const outNote = newNote(value, token, recipient.mpk);
  const outC = commitment(outNote);
  insert(pool, outC, encryptNote(outNote, recipient.viewPubHex));

  const change = total - value;
  const changeCommitment = change > 0n ? mintSelfNote(pool, wallet, keys, token, change) : undefined;
  return { nullifiers, outCommitment: fieldToHex(outC), changeCommitment, root: pool.root };
}

/** Withdraw: spend my notes; value exits the pool (settled on-chain later). */
export function applyUnshield(pool: Pool, wallet: Wallet, keys: ShieldedKeys, value: bigint, token: bigint): SpendResult {
  const { notes: inputs, total } = selectNotes(wallet, token, value);
  const nullifiers = spendInputs(pool, wallet, keys, inputs);
  const change = total - value;
  const changeCommitment = change > 0n ? mintSelfNote(pool, wallet, keys, token, change) : undefined;
  return { nullifiers, changeCommitment, root: pool.root };
}

export type TradeResult = { nullifiers: string[]; outputCommitment: string; changeCommitment?: string; root: string };

/**
 * Private trade: spend `amountIn` of the input token, mint `amountOut` of the
 * output token back to yourself (+ change on the input token). Both new notes are
 * yours; the size and direction stay off the public explorer.
 */
export function applyTrade(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  inputToken: bigint,
  outputToken: bigint,
  amountIn: bigint,
  amountOut: bigint,
): TradeResult {
  const { notes: inputs, total } = selectNotes(wallet, inputToken, amountIn);
  const nullifiers = spendInputs(pool, wallet, keys, inputs);

  const outputCommitment = mintSelfNote(pool, wallet, keys, outputToken, amountOut);

  const change = total - amountIn;
  const changeCommitment = change > 0n ? mintSelfNote(pool, wallet, keys, inputToken, change) : undefined;
  return { nullifiers, outputCommitment, changeCommitment, root: pool.root };
}

// ---- real-spend planning (non-mutating) -------------------------------------
//
// The sim ops above mutate the local pool the instant they run. The real on-chain
// path cannot: it proves first and touches local state only once the chain confirms.
// These builders select inputs and shape outputs WITHOUT mutating anything, hand a
// plan to proveTransfer, and leave recording to the post-transaction sync + scan.

export type PlannedSpend = {
  /** Feed straight to proveTransfer. */
  plan: SpendPlan;
  /** The two outputs to encrypt and publish, in the order the proof appends them. */
  outputs: { note: Note; viewPubHex: string }[];
  /** Leaf indices of the real inputs being spent — for display. */
  inputLeaves: number[];
};

/** Pick one or two unspent notes of `token` covering `need`; a join-split takes at most two. */
function selectUpTo2(wallet: Wallet, token: bigint, need: bigint): StoredNote[] {
  const avail = wallet.notes
    .filter((n) => !n.spent && hexToField(n.token) === token)
    .sort((a, b) => (hexToField(a.value) < hexToField(b.value) ? -1 : 1)); // ascending value
  // The smallest single note that covers it, so the larger notes stay whole.
  const single = avail.find((n) => hexToField(n.value) >= need);
  if (single) return [single];
  // Otherwise the two largest — a join-split cannot consume more than two inputs.
  const two = avail.slice(-2);
  const twoTotal = two.reduce((s, n) => s + hexToField(n.value), 0n);
  if (two.length === 2 && twoTotal >= need) return two;
  const have = avail.reduce((s, n) => s + hexToField(n.value), 0n);
  if (have < need) {
    throw new Error(`Insufficient shielded balance: need ${formatEther(need)}, have ${formatEther(have)}.`);
  }
  throw new Error(
    `Shielded balance is too fragmented: no two notes cover ${formatEther(need)}. Consolidate first by sending yourself a note.`,
  );
}

const outParts = (n: Note): SpendOutput => ({ mpk: n.mpk, value: n.value, blinding: n.blinding });

function planInputs(inputs: StoredNote[]): SpendPlan["inputs"] {
  return inputs.map((n) => ({ value: hexToField(n.value), blinding: hexToField(n.blinding), leafIndex: n.leafIndex }));
}

/**
 * Plan a private send: `value` to the recipient, change back to you, no public
 * leg. Relayed, it is the most private operation the pool has — the sender's
 * wallet appears nowhere on chain. The only public artifact is the relayer's
 * `fee` payout; the amount, the parties, and both output notes stay hidden.
 */
export function planSend(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  recipient: PaymentAddress,
  value: bigint,
  token: bigint,
  chainId: bigint,
  fee: bigint = 0n,
  relayer: bigint = 0n,
): PlannedSpend {
  const inputs = selectUpTo2(wallet, token, value + fee);
  const total = inputs.reduce((s, n) => s + hexToField(n.value), 0n);
  const out0: Note = { value, token, mpk: recipient.mpk, blinding: randomField() };
  const out1: Note = { value: total - value - fee, token, mpk: keys.mpk, blinding: randomField() };
  return {
    plan: {
      sk: keys.sk,
      nk: keys.nk,
      token,
      inputs: planInputs(inputs),
      outputs: [outParts(out0), outParts(out1)],
      leaves: pool.commitments.map(hexToField),
      publicToken: token,
      publicValue: 0n,
      fee,
      recipient: 0n,
      relayer,
      chainId,
    },
    outputs: [
      { note: out0, viewPubHex: recipient.viewPubHex },
      { note: out1, viewPubHex: keys.viewPubHex },
    ],
    inputLeaves: inputs.map((n) => n.leafIndex),
  };
}

/**
 * Plan an unshield: `value` leaves to `payout` (your public address as a field),
 * change stays private. A relayed spend adds `fee` on top — paid to `relayer`
 * out of the same notes, bound into the proof — so the relayer can submit from
 * its own wallet and the chain never sees yours pay for gas.
 */
export function planUnshield(
  pool: Pool,
  wallet: Wallet,
  keys: ShieldedKeys,
  value: bigint,
  token: bigint,
  payout: bigint,
  chainId: bigint,
  fee: bigint = 0n,
  relayer: bigint = 0n,
): PlannedSpend {
  const inputs = selectUpTo2(wallet, token, value + fee);
  const total = inputs.reduce((s, n) => s + hexToField(n.value), 0n);
  const out0: Note = { value: total - value - fee, token, mpk: keys.mpk, blinding: randomField() };
  const out1: Note = { value: 0n, token, mpk: keys.mpk, blinding: randomField() };
  return {
    plan: {
      sk: keys.sk,
      nk: keys.nk,
      token,
      inputs: planInputs(inputs),
      outputs: [outParts(out0), outParts(out1)],
      leaves: pool.commitments.map(hexToField),
      publicToken: token,
      publicValue: value,
      fee,
      recipient: payout,
      relayer,
      chainId,
    },
    outputs: [
      { note: out0, viewPubHex: keys.viewPubHex },
      { note: out1, viewPubHex: keys.viewPubHex },
    ],
    inputLeaves: inputs.map((n) => n.leafIndex),
  };
}

// ---- storage layer ----------------------------------------------------------

// The pool is the shared ledger; point COWL_POOL_DIR at a shared path to run a
// multi-party demo on one machine. Notes stay under the per-wallet home.
const POOL_DIR = process.env.COWL_POOL_DIR ?? join(COWL_DIR, "shielded");
const NOTES_DIR = join(COWL_DIR, "shielded");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadPool(net: string): Pool {
  const path = join(POOL_DIR, `pool-${net}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Pool) : emptyPool();
}
export function savePool(net: string, pool: Pool): void {
  ensureDir(POOL_DIR);
  writeFileSync(join(POOL_DIR, `pool-${net}.json`), JSON.stringify(pool, null, 2) + "\n", { mode: 0o600 });
}
export function loadWallet(net: string): Wallet {
  const path = join(NOTES_DIR, `notes-${net}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Wallet) : emptyWallet();
}
function saveWallet(net: string, w: Wallet): void {
  ensureDir(NOTES_DIR);
  writeFileSync(join(NOTES_DIR, `notes-${net}.json`), JSON.stringify(w, null, 2) + "\n", { mode: 0o600 });
}

// ---- CLI-facing wrappers (load → apply → save) ------------------------------

export function shield(net: string, keys: ShieldedKeys, value: bigint, token: bigint): ShieldResult {
  const pool = loadPool(net), wallet = loadWallet(net);
  const res = applyShield(pool, wallet, keys, value, token);
  savePool(net, pool);
  saveWallet(net, wallet);
  return res;
}

/**
 * Rebuild the local commitment log from the chain's, then record a note we just
 * deposited at the leaf index the CONTRACT assigned.
 *
 * The chain is the authority on ordering: between building a note and landing the
 * transaction, anyone else's deposit can take the index the local tree expected. So
 * the local log follows the chain's, and a deposited note is filed against the index
 * the receipt reported — never a locally guessed one.
 */

/** The local log and the chain's log disagree — only a full replay can reconcile. */
export class ChainDrift extends Error {}

/**
 * Append newly seen on-chain leaves to the local log. Incremental on purpose: the
 * usual sync carries a handful of leaves, so the overlap check plus an append beats
 * rebuilding the whole pool. Throws ChainDrift when the logs disagree — an overlap
 * mismatch (stale sim-era state, a reorg) or a gap (cursor block was skipped) —
 * and the caller falls back to a full replay.
 */
export function applyChainLeaves(
  pool: Pool,
  leaves: { index: number; commitment: string; cipher?: string }[],
  nullifiers: string[],
  totalLeaves: number,
  chainRoot?: string,
): number {
  let appended = 0;
  for (const leaf of [...leaves].sort((a, b) => a.index - b.index)) {
    if (leaf.index < pool.commitments.length) {
      if (pool.commitments[leaf.index] !== leaf.commitment) {
        throw new ChainDrift(`Local leaf #${leaf.index} does not match the chain.`);
      }
      continue;
    }
    if (leaf.index > pool.commitments.length) {
      throw new ChainDrift(`Leaf #${leaf.index} arrived before #${pool.commitments.length}.`);
    }
    pool.commitments.push(leaf.commitment);
    pool.ciphertexts.push(leaf.cipher ? unpackCipher(leaf.cipher) : null);
    appended++;
  }

  // The spent set is a chain log too — merge in any new Nullified so a note the
  // pool nullified (mine or anyone's) shows as spent after a plain incremental sync.
  const knownNulls = new Set(pool.nullifiers);
  for (const nf of nullifiers) {
    if (!knownNulls.has(nf)) {
      pool.nullifiers.push(nf);
      knownNulls.add(nf);
    }
  }
  if (pool.commitments.length !== totalLeaves) {
    throw new ChainDrift(
      `Pool has ${totalLeaves} leaves on chain but ${pool.commitments.length} locally.`,
    );
  }
  if (appended > 0) pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
  // The count only says how many leaves there are. The root says they are the
  // right leaves in the right order — a corrupted or reordered log that happens
  // to be the right length gets caught here and nowhere else.
  if (chainRoot !== undefined && pool.root !== chainRoot) {
    throw new ChainDrift(`Local root ${pool.root} does not match the chain's ${chainRoot}.`);
  }
  return appended;
}

/**
 * Replace the local log with the chain's wholesale — the ChainDrift recovery path.
 * Ciphertexts are carried across by commitment value, not by position, so stale
 * local state can never leave a note glued to someone else's leaf.
 */
export function alignPoolToChain(
  pool: Pool,
  leaves: { index: number; commitment: string; cipher?: string }[],
  nullifiers: string[],
): void {
  // The chain now carries the ciphertext for every leaf, so it is the source of
  // truth. A locally-held cipher (a note we just created, not yet echoed back) is
  // kept only as a fallback for a leaf the chain query somehow returned without one.
  const localCipher = new Map<string, NoteCipher>();
  pool.commitments.forEach((c, i) => {
    const cipher = pool.ciphertexts[i];
    if (cipher) localCipher.set(c, cipher);
  });
  const commitments: string[] = [];
  const ciphertexts: (NoteCipher | null)[] = [];
  for (const leaf of [...leaves].sort((a, b) => a.index - b.index)) {
    commitments[leaf.index] = leaf.commitment;
    ciphertexts[leaf.index] = leaf.cipher
      ? unpackCipher(leaf.cipher)
      : (localCipher.get(leaf.commitment) ?? null);
  }
  pool.commitments = commitments;
  pool.ciphertexts = ciphertexts;
  pool.nullifiers = [...new Set(nullifiers)];
  pool.root = fieldToHex(computeRoot(pool.commitments.map(hexToField)));
}

/**
 * File a note we just deposited, after a sync has brought the local log up to the
 * chain. Verifies the chain put our commitment where the receipt said before
 * anything is written.
 */
export function recordMyNote(net: string, keys: ShieldedKeys, note: Note, leafIndex: number): ShieldResult {
  const pool = loadPool(net), wallet = loadWallet(net);

  const c = fieldToHex(commitment(note));
  if (pool.commitments[leafIndex] !== c) {
    throw new Error(
      `Chain leaf #${leafIndex} holds ${pool.commitments[leafIndex] ?? "nothing"}, not the commitment we deposited (${c}).`,
    );
  }

  pool.ciphertexts[leafIndex] = encryptNote(note, keys.viewPubHex);
  if (!wallet.notes.some((n) => n.leafIndex === leafIndex)) wallet.notes.push(toStored(note, leafIndex));
  if (wallet.pending) wallet.pending = wallet.pending.filter((pn) => pn.commitment !== c);
  savePool(net, pool);
  saveWallet(net, wallet);
  return { leafIndex, commitment: c, root: pool.root };
}

/** Stash a note's secrets on disk before its deposit broadcasts — see PendingNote. */
export function stashPendingNote(net: string, note: Note): void {
  const wallet = loadWallet(net);
  const c = fieldToHex(commitment(note));
  wallet.pending = wallet.pending ?? [];
  if (!wallet.pending.some((pn) => pn.commitment === c)) {
    wallet.pending.push({
      value: fieldToHex(note.value),
      token: fieldToHex(note.token),
      blinding: fieldToHex(note.blinding),
      commitment: c,
    });
  }
  saveWallet(net, wallet);
}

export function scan(net: string, keys: ShieldedKeys): { discovered: number } {
  const pool = loadPool(net), wallet = loadWallet(net);
  const res = applyScan(pool, wallet, keys);
  saveWallet(net, wallet);
  return res;
}

export function balance(net: string, keys: ShieldedKeys): Balance {
  const pool = loadPool(net), wallet = loadWallet(net);
  applyScan(pool, wallet, keys);
  saveWallet(net, wallet);
  return computeBalance(wallet);
}

export function sendPrivate(net: string, keys: ShieldedKeys, recipient: PaymentAddress, value: bigint, token: bigint): SpendResult {
  const pool = loadPool(net), wallet = loadWallet(net);
  applyScan(pool, wallet, keys);
  const res = applySend(pool, wallet, keys, recipient, value, token);
  savePool(net, pool);
  saveWallet(net, wallet);
  return res;
}

export function unshield(net: string, keys: ShieldedKeys, value: bigint, token: bigint): SpendResult {
  const pool = loadPool(net), wallet = loadWallet(net);
  applyScan(pool, wallet, keys);
  const res = applyUnshield(pool, wallet, keys, value, token);
  savePool(net, pool);
  saveWallet(net, wallet);
  return res;
}

export function trade(
  net: string,
  keys: ShieldedKeys,
  inputToken: bigint,
  outputToken: bigint,
  amountIn: bigint,
  amountOut: bigint,
): TradeResult {
  const pool = loadPool(net), wallet = loadWallet(net);
  applyScan(pool, wallet, keys);
  const res = applyTrade(pool, wallet, keys, inputToken, outputToken, amountIn, amountOut);
  savePool(net, pool);
  saveWallet(net, wallet);
  return res;
}

/** True while the pool contract is undeployed — flags the local-only nature in the UI. */
export function isLocalOnly(poolContract?: string): boolean {
  return !poolContract;
}
