// A shielded note is a private UTXO: a hidden amount of one token owned by one
// master public key. Its commitment goes into the on-chain Merkle tree; spending
// it later reveals only a nullifier, never the note itself.
import { poseidon, randomField, DOMAIN_NULLIFIER } from "./field.js";
import { TOKENS_BY_SYMBOL, TOKENS_BY_FIELD } from "./tokens.js";

export type Note = {
  value: bigint; // base units (wei / token smallest unit)
  token: bigint; // 0 = native coin, else the ERC-20 address as a field element
  mpk: bigint; // owner master public key
  blinding: bigint; // per-note randomness
};

/** Native coin is token id 0; listed symbols and ERC-20 addresses map to a field. */
export function tokenToField(token: string, nativeSymbol: string): bigint {
  const up = token.toUpperCase();
  if (up === nativeSymbol.toUpperCase()) return 0n;
  const known = TOKENS_BY_SYMBOL.get(up);
  if (known) return known.field;
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) return BigInt(token);
  throw new Error(`Unknown token "${token}". Use ${nativeSymbol}, a listed symbol (USDG, TSLA, …), or an ERC-20 address.`);
}

/** Render a token field back to a human label. */
export function tokenLabel(token: bigint, nativeSymbol: string): string {
  if (token === 0n) return nativeSymbol;
  return TOKENS_BY_FIELD.get(token)?.symbol ?? "0x" + token.toString(16).padStart(40, "0");
}

export function newNote(value: bigint, token: bigint, mpk: bigint): Note {
  return { value, token, mpk, blinding: randomField() };
}

/** commitment = Poseidon(mpk, token, value, blinding) */
export function commitment(n: Note): bigint {
  return poseidon([n.mpk, n.token, n.value, n.blinding]);
}

/** nullifier = Poseidon(DOMAIN_NULLIFIER, nullifyingKey, leafIndex) — unlinkable to the commitment. */
export function nullifier(nk: bigint, leafIndex: number | bigint): bigint {
  return poseidon([DOMAIN_NULLIFIER, nk, BigInt(leafIndex)]);
}
