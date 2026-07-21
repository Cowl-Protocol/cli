// Shielded-pool keys, all derived deterministically from the wallet's private key
// so the whole shielded balance is recoverable from one seed.
//
//   spendingKey  sk   secret field element — authorizes spends
//   nullifyingKey nk  = Poseidon(sk)        — seeds nullifiers (unlinkable)
//   masterPubKey mpk  = Poseidon(sk, nk)    — the note owner id ("npk")
//
// A separate secp256k1 view key (shared with the stealth module) encrypts notes to
// a recipient and lets them scan the pool for what is theirs.
import { hexToBytes } from "@noble/hashes/utils";
import { deriveMetaKeys } from "../stealth.js";
import { hashToField, poseidon, fieldToHex, hexToField } from "./field.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

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

  // Reuse the stealth secp256k1 view key so there is one canonical scanning key.
  const meta = deriveMetaKeys(privateKeyHex);

  return {
    sk,
    nk,
    mpk,
    viewPriv: meta.viewPriv,
    viewPubHex: meta.viewPubHex,
    paymentAddress: encodePaymentAddress(mpk, meta.viewPubHex),
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
