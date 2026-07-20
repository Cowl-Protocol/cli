// Real ERC-5564-style stealth addresses over secp256k1.
// Spending and viewing keys are derived deterministically from the wallet key,
// so stealth addresses can always be recovered from a single seed.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
import { getAddress } from "viem";

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

function mod(x: bigint): bigint {
  const r = x % N;
  return r < 0n ? r + N : r;
}

function toScalar(bytes: Uint8Array): bigint {
  const s = mod(BigInt("0x" + bytesToHex(bytes)));
  return s === 0n ? 1n : s;
}

function pubToAddress(point: InstanceType<typeof Point>): `0x${string}` {
  const uncompressed = point.toRawBytes(false).slice(1); // drop 0x04 prefix
  const hash = keccak_256(uncompressed);
  return getAddress(("0x" + bytesToHex(hash.slice(-20))) as `0x${string}`);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export type MetaKeys = {
  spendPriv: bigint;
  viewPriv: bigint;
  spendPubHex: string; // compressed
  viewPubHex: string; // compressed
  metaAddress: string; // st:cowl:...
};

export function deriveMetaKeys(privateKeyHex: string): MetaKeys {
  const pk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const spendPriv = toScalar(pk);
  const viewPriv = toScalar(keccak_256(concatBytes(pk, utf8("cowl:view"))));
  const spendPub = Point.BASE.multiply(spendPriv);
  const viewPub = Point.BASE.multiply(viewPriv);
  const spendPubHex = bytesToHex(spendPub.toRawBytes(true));
  const viewPubHex = bytesToHex(viewPub.toRawBytes(true));
  return {
    spendPriv,
    viewPriv,
    spendPubHex,
    viewPubHex,
    metaAddress: `st:cowl:0x${spendPubHex}${viewPubHex}`,
  };
}

export type StealthResult = {
  stealthAddress: `0x${string}`;
  ephemeralPubKey: string; // compressed hex, 0x…
  viewTag: string; // 1 byte hex
};

/** Generate a fresh one-time stealth address for the given meta keys. */
export function generateStealthAddress(meta: MetaKeys): StealthResult {
  const spendPub = Point.fromHex(meta.spendPubHex);
  const viewPub = Point.fromHex(meta.viewPubHex);

  const ephPriv = toScalar(secp256k1.utils.randomPrivateKey());
  const ephPub = Point.BASE.multiply(ephPriv);

  const shared = viewPub.multiply(ephPriv); // ECDH
  const sharedHash = keccak_256(shared.toRawBytes(true));
  const tweak = toScalar(sharedHash);

  const stealthPub = spendPub.add(Point.BASE.multiply(tweak));

  return {
    stealthAddress: pubToAddress(stealthPub),
    ephemeralPubKey: "0x" + bytesToHex(ephPub.toRawBytes(true)),
    viewTag: "0x" + bytesToHex(sharedHash.slice(0, 1)),
  };
}
