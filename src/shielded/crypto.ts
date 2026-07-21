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

type Payload = { v: string; t: string; b: string }; // value, token, blinding (hex)

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

  const payload: Payload = {
    v: note.value.toString(16),
    t: note.token.toString(16),
    b: note.blinding.toString(16),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
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
    const p = JSON.parse(plain.toString("utf8")) as Payload;
    return { value: BigInt("0x" + p.v), token: BigInt("0x" + p.t), blinding: BigInt("0x" + p.b) };
  } catch {
    return null;
  }
}

// Re-exported for callers that only need the byte helpers.
export { bytesToHex, hexToBytes };
