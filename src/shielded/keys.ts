// Shielded-pool keys, all derived deterministically from the wallet's private key
// so the whole shielded balance is recoverable from one seed.
//
//   spendingKey  sk   secret field element — authorizes spends
//   nullifyingKey nk  = Poseidon(sk)                — seeds nullifiers (unlinkable)
//   masterPubKey mpk  = Poseidon(DOMAIN_MPK, sk, nk) — the note owner id ("npk")
//
// A separate secp256k1 view key (shared with the stealth module) encrypts notes to
// a recipient and lets them scan the pool for what is theirs.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";
import { hashToField, poseidon, fieldToHex, hexToField, DOMAIN_MPK } from "./field.js";

const Point = secp256k1.ProjectivePoint;
const CURVE_N = secp256k1.CURVE.n;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Reduce bytes into a secp256k1 scalar. Note this is the curve order, not Fr. */
function toCurveScalar(bytes: Uint8Array): bigint {
  const s = BigInt("0x" + bytesToHex(bytes)) % CURVE_N;
  return s === 0n ? 1n : s;
}

/**
 * Which secret the account was grown from.
 *
 * `key` seeds from the private key — the terminal's own account, and what this
 * CLI has always used. `sig-v1` seeds from a signature over a fixed message,
 * because a browser wallet will never hand a web page the private key; that is
 * the account app.cowlprotocol.com operates. Same formulas below either way, so
 * the pool and the circuits cannot tell them apart — but a different seed is a
 * different `mpk`, which is to say a different set of notes. One wallet really
 * does own two shielded books, and they are told apart only here.
 */
export type AccountSpace = "key" | "sig-v1";

export type ShieldedKeys = {
  sk: bigint; // spending key (secret)
  nk: bigint; // nullifying key
  mpk: bigint; // master public key — note owner id
  viewPriv: bigint; // secp256k1 scalar — decrypts incoming notes
  viewPubHex: string; // compressed secp256k1 point (no 0x)
  paymentAddress: string; // zcowl1… — share this to receive privately
  space: AccountSpace;
};

/**
 * The message the browser app has its wallet sign to unlock the same account.
 *
 * Fixed forever and byte-for-byte identical to the app's copy: change one
 * character and every key below changes with it, stranding the notes behind
 * them. Signing is deterministic (RFC 6979), so the same wallet signing this
 * always produces the same bytes — in a browser wallet or here.
 */
export const SHIELDED_SIGN_MESSAGE =
  "Cowl Protocol shielded account v1\n\n" +
  "This signature derives the keys to your shielded balance. " +
  "Only sign it on app.cowlprotocol.com.";

export function deriveShieldedKeys(privateKeyHex: string): ShieldedKeys {
  const pk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const sk = hashToField(pk, utf8("cowl:shielded:spend"));
  const nk = poseidon([sk]);
  const mpk = poseidon([DOMAIN_MPK, sk, nk]);

  // A view key of its own, under a separate domain. Sharing the stealth view key
  // would make a published stealth meta-address and a published payment address
  // carry the same trailing bytes, letting anyone tie the two together.
  const viewPriv = toCurveScalar(keccak_256(concatBytes(pk, utf8("cowl:shielded:view"))));
  const viewPubHex = bytesToHex(Point.BASE.multiply(viewPriv).toRawBytes(true));

  return {
    sk,
    nk,
    mpk,
    viewPriv,
    viewPubHex,
    paymentAddress: encodePaymentAddress(mpk, viewPubHex),
    space: "key",
  };
}

/**
 * The browser app's account, derived here from its unlock signature.
 *
 * Transcribed from app/lib/shielded/keys.ts and it must stay that way: the same
 * domain tags, the same order, the same reductions. Anything that drifts sends
 * this CLI looking for notes at an `mpk` the app never wrote to, and the only
 * symptom is a balance that reads empty.
 */
export function deriveShieldedKeysFromSignature(signatureHex: string): ShieldedKeys {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
  if (sig.length < 64) throw new Error("Unlock signature is too short to derive keys from.");
  const sk = hashToField(sig, utf8("cowl:shielded:spend:sig-v1"));
  const nk = poseidon([sk]);
  const mpk = poseidon([DOMAIN_MPK, sk, nk]);

  const viewPriv = toCurveScalar(keccak_256(concatBytes(sig, utf8("cowl:shielded:view:sig-v1"))));
  const viewPubHex = bytesToHex(Point.BASE.multiply(viewPriv).toRawBytes(true));

  return {
    sk,
    nk,
    mpk,
    viewPriv,
    viewPubHex,
    paymentAddress: encodePaymentAddress(mpk, viewPubHex),
    space: "sig-v1",
  };
}

/**
 * zcowl1… — bech32m over <mpk:32B><viewPub:33B compressed>, prefix "zcowl".
 * The checksum means a mistyped character fails to decode instead of paying
 * keys nobody holds. Longer than the spec's 90-char ceiling, like Zcash
 * unified addresses, so every decode passes an explicit no-limit.
 */
export function encodePaymentAddress(mpk: bigint, viewPubHex: string): string {
  const bytes = hexToBytes(fieldToHex(mpk).slice(2) + viewPubHex.replace(/^0x/, ""));
  return bech32m.encode("zcowl", bech32m.toWords(bytes), false);
}

export type PaymentAddress = { mpk: bigint; viewPubHex: string };

export function decodePaymentAddress(addr: string): PaymentAddress {
  const s = addr.trim();
  // The pre-checksum zcowl:0x… form still decodes; nothing emits it anymore.
  const legacy = s.match(/^zcowl:0x([0-9a-fA-F]{64})([0-9a-fA-F]{66})$/);
  if (legacy) return { mpk: hexToField("0x" + legacy[1]!), viewPubHex: legacy[2]! };
  let bytes: Uint8Array;
  try {
    // bech32 forbids mixed case; all-caps (QR alphanumeric mode) is one case.
    const oneCase = s === s.toUpperCase() ? s.toLowerCase() : s;
    const dec = bech32m.decode(oneCase as `${string}1${string}`, false);
    if (dec.prefix !== "zcowl") throw new Error("wrong prefix");
    bytes = bech32m.fromWords(dec.words);
  } catch {
    throw new Error("Invalid zcowl payment address.");
  }
  if (bytes.length !== 65) throw new Error("Invalid zcowl payment address.");
  const hex = bytesToHex(bytes);
  return { mpk: hexToField("0x" + hex.slice(0, 64)), viewPubHex: hex.slice(64) };
}

export function isPaymentAddress(s: string): boolean {
  try {
    decodePaymentAddress(s);
    return true;
  } catch {
    return false;
  }
}
