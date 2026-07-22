// Encrypt a note to a recipient's secp256k1 view key so only they can find it.
// The sender attaches an ephemeral public key; the recipient scans every pool
// ciphertext, does one ECDH, and decrypts the ones meant for them. A one-byte
// view tag lets a scan skip most ciphertexts without touching AES.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Note } from "./note.js";

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

export type NoteCipher = {
  eph: string; // ephemeral compressed pubkey, no 0x
  tag: string; // AES-GCM auth tag (hex)
  iv: string; // AES-GCM iv (hex)
  ct: string; // ciphertext (hex)
  vt: string; // 1-byte view tag (hex) for fast scan filtering
};

// AES-GCM ciphertext is exactly as long as its plaintext, so the payload's
// encoding is itself a side channel: a payload of unpadded hex made a 1 ETH note
// and a 1000 ETH note encrypt to visibly different lengths, leaking the magnitude
// of a "hidden" amount to anyone counting bytes in the log. Every field is packed
// at a fixed 32 bytes instead, so every note encrypts to the same 96.
const FIELD_BYTES = 32;
const PAYLOAD_BYTES = 3 * FIELD_BYTES; // value, token, blinding

function packField(v: bigint): Buffer {
  const hex = v.toString(16);
  if (hex.length > FIELD_BYTES * 2) throw new Error(`Field element too wide to pack: 0x${hex}`);
  return Buffer.from(hex.padStart(FIELD_BYTES * 2, "0"), "hex");
}

function unpackField(b: Buffer): bigint {
  return BigInt("0x" + b.toString("hex"));
}

function sharedKey(point: InstanceType<typeof Point>): { key: Buffer; viewTag: string } {
  const h = keccak_256(point.toRawBytes(true));
  return { key: Buffer.from(h), viewTag: bytesToHex(h.slice(0, 1)) };
}

/** Encrypt a note to `viewPubHex` (recipient's compressed secp256k1 view key). */
export function encryptNote(note: Note, viewPubHex: string): NoteCipher {
  const viewPub = Point.fromHex(viewPubHex.replace(/^0x/, ""));
  let ephPriv = BigInt("0x" + bytesToHex(secp256k1.utils.randomPrivateKey())) % N;
  if (ephPriv === 0n) ephPriv = 1n;
  const ephPub = Point.BASE.multiply(ephPriv);
  const { key, viewTag } = sharedKey(viewPub.multiply(ephPriv));

  const payload = Buffer.concat([packField(note.value), packField(note.token), packField(note.blinding)]);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    eph: bytesToHex(ephPub.toRawBytes(true)),
    tag: cipher.getAuthTag().toString("hex"),
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    vt: viewTag,
  };
}

/** Try to decrypt with `viewPriv`. Returns note fields, or null if not ours. */
export function tryDecryptNote(
  c: NoteCipher,
  viewPriv: bigint,
): { value: bigint; token: bigint; blinding: bigint } | null {
  const ephPub = Point.fromHex(c.eph);
  const { key, viewTag } = sharedKey(ephPub.multiply(viewPriv));
  if (viewTag !== c.vt) return null; // fast reject
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(c.iv, "hex"));
    decipher.setAuthTag(Buffer.from(c.tag, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(c.ct, "hex")), decipher.final()]);
    if (plain.length !== PAYLOAD_BYTES) return null;
    return {
      value: unpackField(plain.subarray(0, FIELD_BYTES)),
      token: unpackField(plain.subarray(FIELD_BYTES, 2 * FIELD_BYTES)),
      blinding: unpackField(plain.subarray(2 * FIELD_BYTES, PAYLOAD_BYTES)),
    };
  } catch {
    return null;
  }
}

// Re-exported for callers that only need the byte helpers.
export { bytesToHex, hexToBytes };
