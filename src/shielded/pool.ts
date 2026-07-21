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
import { fieldToHex, hexToField } from "./field.js";
import { type Note, commitment, nullifier, newNote } from "./note.js";
import { computeRoot } from "./tree.js";
import { type NoteCipher, encryptNote, tryDecryptNote } from "./crypto.js";
import type { ShieldedKeys, PaymentAddress } from "./keys.js";

// ---- types ------------------------------------------------------------------

export type Pool = {
  commitments: string[]; // hex, insertion order = leaf index
  nullifiers: string[]; // hex, the spent set
  ciphertexts: NoteCipher[]; // one per commitment (same index)
  root: string; // current Merkle root (hex)
};

export type StoredNote = {
  value: string; // hex
  token: string; // hex
  blinding: string; // hex
  leafIndex: number;
  spent: boolean;
};

export type Wallet = { notes: StoredNote[] };

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
  const known = new Set(wallet.notes.map((n) => n.leafIndex));
  const nulls = new Set(pool.nullifiers);
  let discovered = 0;

  for (let i = 0; i < pool.ciphertexts.length; i++) {
    if (known.has(i)) continue;
    const dec = tryDecryptNote(pool.ciphertexts[i]!, keys.viewPriv);
    if (!dec) continue;
    const note: Note = { value: dec.value, token: dec.token, mpk: keys.mpk, blinding: dec.blinding };
    if (fieldToHex(commitment(note)) !== pool.commitments[i]) continue; // not really ours
    wallet.notes.push(toStored(note, i));
    known.add(i);
    discovered++;
  }

  for (const n of wallet.notes) {
    if (!n.spent && nulls.has(fieldToHex(nullifier(keys.nk, n.leafIndex)))) n.spent = true;
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
function savePool(net: string, pool: Pool): void {
  ensureDir(POOL_DIR);
  writeFileSync(join(POOL_DIR, `pool-${net}.json`), JSON.stringify(pool, null, 2) + "\n", { mode: 0o600 });
}
function loadWallet(net: string): Wallet {
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
