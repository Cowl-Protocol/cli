// Shielded-pool keys, all derived deterministically from the wallet's private key
// so the whole shielded balance is recoverable from one seed.
//
//   spendingKey  sk   secret field element — authorizes spends
//   nullifyingKey nk  = Poseidon(sk)        — seeds nullifiers (unlinkable)
//   masterPubKey mpk  = Poseidon(sk, nk)    — the note owner id ("npk")
//
// A separate secp256k1 view key (shared with the stealth module) encrypts notes to
// a recipient and lets them scan the pool for what is theirs.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
import { hashToField, poseidon, fieldToHex, hexToField } from "./field.js";

const Point = secp256k1.ProjectivePoint;
const CURVE_N = secp256k1.CURVE.n;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Reduce bytes into a secp256k1 scalar. Note this is the curve order, not Fr. */
function toCurveScalar(bytes: Uint8Array): bigint {
  const s = BigInt("0x" + bytesToHex(bytes)) % CURVE_N;
  return s === 0n ? 1n : s;
}

export type ShieldedKeys = {
  sk: bigint; // spending key (secret)
  nk: bigint; // nullifying key
  mpk: bigint; // master public key — note owner id
  viewPriv: bigint; // secp256k1 scalar — decrypts incoming notes
  viewPubHex: string; // compressed secp256k1 point (no 0x)
  paymentAddress: string; // zcowl:0x… — share this to receive privately
};

export function deriveShieldedKeys(privateKeyHex: string): ShieldedKeys {
  const pk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const sk = hashToField(pk, utf8("cowl:shielded:spend"));
  const nk = poseidon([sk]);
  const mpk = poseidon([sk, nk]);

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
  };
}

/** zcowl:0x<mpk:32B><viewPub:33B compressed> */
export function encodePaymentAddress(mpk: bigint, viewPubHex: string): string {
  const mpkHex = fieldToHex(mpk).slice(2); // 64 chars
  const viewHex = viewPubHex.replace(/^0x/, ""); // 66 chars (compressed)
  return `zcowl:0x${mpkHex}${viewHex}`;
}

export type PaymentAddress = { mpk: bigint; viewPubHex: string };

export function decodePaymentAddress(addr: string): PaymentAddress {
  const m = addr.trim().match(/^zcowl:0x([0-9a-fA-F]{64})([0-9a-fA-F]{66})$/);
  if (!m) throw new Error("Invalid zcowl payment address.");
  return { mpk: hexToField("0x" + m[1]!), viewPubHex: m[2]! };
}

export function isPaymentAddress(s: string): boolean {
  return /^zcowl:0x[0-9a-fA-F]{130}$/.test(s.trim());
}
