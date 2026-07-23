// The relayer wire format and the client half of it.
//
// A relayer is a submitter, not a custodian. The join-split proof already binds
// `recipient`, `relayer` and `fee` — hashed into the circuit's payout tag — so
// the relayer can submit the spend from its own wallet, collect the fee leg,
// and change nothing. What it severs is the link the chain would otherwise
// print: the gas payer. A spend submitted by a relayer carries no trace of the
// wallet that built it, and a payout can land on a fresh address that holds no
// gas at all.
//
// JSON carries bigints as decimal strings and bytes as 0x-hex.
import type { SpendStruct } from "../shielded/prove.js";
import type { TradeSubmission } from "../shielded/contract.js";

export type RelayQuote = {
  /** The relayer's payout address — goes into the plan as the `relayer` field. */
  relayer: `0x${string}`;
  /** The relayer's gas cost per spend, wei, in the native coin. */
  feeWei: bigint;
  /** The token the quote was priced in: "0" for native, else the address. */
  token: string;
  /** Fee per spend in that token's base units — what the proof binds. */
  fee: bigint;
  chainId: number;
  pool: `0x${string}`;
};

export type RelayReceipt = {
  hash: `0x${string}`;
  gasUsed: bigint;
  blockNumber: bigint;
};

type WireSpend = {
  membershipRoot: string;
  nullifiers: [string, string];
  commitments: [string, string];
  newRoot: string;
  token: string;
  value: string;
  fee: string;
  recipient: string;
  relayer: string;
};

export function encodeSpend(s: SpendStruct): WireSpend {
  return {
    membershipRoot: s.membershipRoot,
    nullifiers: [s.nullifiers[0], s.nullifiers[1]],
    commitments: [s.commitments[0], s.commitments[1]],
    newRoot: s.newRoot,
    token: s.token.toString(),
    value: s.value.toString(),
    fee: s.fee.toString(),
    recipient: s.recipient.toString(),
    relayer: s.relayer.toString(),
  };
}

const hex = (v: unknown, what: string): `0x${string}` => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`Bad ${what} in relay payload.`);
  return v as `0x${string}`;
};
const big = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new Error(`Bad ${what} in relay payload.`);
  return BigInt(v);
};

export function decodeSpend(w: WireSpend): SpendStruct {
  return {
    membershipRoot: hex(w.membershipRoot, "membershipRoot"),
    nullifiers: [hex(w.nullifiers?.[0], "nullifier"), hex(w.nullifiers?.[1], "nullifier")],
    commitments: [hex(w.commitments?.[0], "commitment"), hex(w.commitments?.[1], "commitment")],
    newRoot: hex(w.newRoot, "newRoot"),
    token: big(w.token, "token"),
    value: big(w.value, "value"),
    fee: big(w.fee, "fee"),
    recipient: big(w.recipient, "recipient"),
    relayer: big(w.relayer, "relayer"),
  };
}

const clean = (url: string) => url.replace(/\/+$/, "");

export type WireTrade = {
  spend: WireSpend;
  ciphertexts: [string, string];
  spendProof: string;
  tokenOut: string;
  amountOut: string;
  poolFee: number;
  shieldCommitment: string;
  shieldNewRoot: string;
  shieldCiphertext: string;
  shieldProof: string;
};

export function encodeTrade(t: TradeSubmission): WireTrade {
  return {
    spend: encodeSpend(t.spend),
    ciphertexts: [t.spendCiphertexts[0], t.spendCiphertexts[1]],
    spendProof: t.spendProof,
    tokenOut: t.tokenOut.toString(),
    amountOut: t.amountOut.toString(),
    poolFee: t.poolFee,
    shieldCommitment: t.shieldCommitment,
    shieldNewRoot: t.shieldNewRoot,
    shieldCiphertext: t.shieldCiphertext,
    shieldProof: t.shieldProof,
  };
}

export function decodeTrade(w: WireTrade): TradeSubmission {
  return {
    spend: decodeSpend(w.spend),
    spendCiphertexts: [hex(w.ciphertexts?.[0], "ciphertext"), hex(w.ciphertexts?.[1], "ciphertext")],
    spendProof: hex(w.spendProof, "spendProof"),
    tokenOut: big(w.tokenOut, "tokenOut"),
    amountOut: big(w.amountOut, "amountOut"),
    poolFee: Number(w.poolFee) || 3000,
    shieldCommitment: hex(w.shieldCommitment, "shieldCommitment"),
    shieldNewRoot: hex(w.shieldNewRoot, "shieldNewRoot"),
    shieldCiphertext: hex(w.shieldCiphertext, "shieldCiphertext"),
    shieldProof: hex(w.shieldProof, "shieldProof"),
  };
}

/**
 * Ask a relayer what it charges and where its fee should be paid. Pass a token
 * address to have the fee priced in that ERC-20 — the fee leg of a spend pays
 * in the spend's own token. A trade burns roughly three spends' worth of gas,
 * so ask with op "trade" to have the quote sized for one.
 */
export async function fetchQuote(
  url: string,
  token?: `0x${string}`,
  op: "spend" | "trade" = "spend",
): Promise<RelayQuote> {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (op !== "spend") params.set("op", op);
  const qs = params.size ? `?${params.toString()}` : "";
  let res: Response;
  try {
    res = await fetch(`${clean(url)}/quote${qs}`);
  } catch {
    throw new Error(`No relayer answering at ${url}.`);
  }
  const q = (await res.json().catch(() => ({}))) as {
    relayer?: unknown;
    feeWei?: unknown;
    token?: unknown;
    fee?: unknown;
    chainId?: unknown;
    pool?: unknown;
    error?: unknown;
  };
  if (!res.ok) {
    throw new Error(typeof q.error === "string" ? q.error : `Relayer at ${url} refused the quote (${res.status}).`);
  }
  if (typeof q.relayer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(q.relayer)) {
    throw new Error("Relayer sent a malformed quote.");
  }
  const feeWei = big(q.feeWei, "feeWei");
  return {
    relayer: q.relayer as `0x${string}`,
    feeWei,
    token: typeof q.token === "string" ? q.token : "0",
    fee: q.fee === undefined ? feeWei : big(q.fee, "fee"),
    chainId: Number(q.chainId),
    pool: hex(q.pool, "pool"),
  };
}

async function post(url: string, path: string, payload: unknown, what: string): Promise<RelayReceipt> {
  let res: Response;
  try {
    res = await fetch(`${clean(url)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`No relayer answering at ${url}.`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    hash?: unknown;
    gasUsed?: unknown;
    blockNumber?: unknown;
  };
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Relayer rejected the ${what} (${res.status}).`);
  }
  return {
    hash: hex(body.hash, "hash"),
    gasUsed: big(body.gasUsed, "gasUsed"),
    blockNumber: big(body.blockNumber, "blockNumber"),
  };
}

/** Hand a proven spend to the relayer and wait for its receipt. */
export async function relaySpend(
  url: string,
  spend: SpendStruct,
  ciphertexts: [`0x${string}`, `0x${string}`],
  proof: `0x${string}`,
): Promise<RelayReceipt> {
  return post(url, "/relay", { spend: encodeSpend(spend), ciphertexts, proof }, "spend");
}

/** Hand a proven atomic trade to the relayer and wait for its receipt. */
export async function relayTrade(url: string, t: TradeSubmission): Promise<RelayReceipt> {
  return post(url, "/trade", encodeTrade(t), "trade");
}
