import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount, generateMnemonic, mnemonicToAccount, english } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { KEYSTORE_PATH, ensureHome } from "./paths.js";

/** An AES-256-GCM blob keyed by scrypt over the passphrase. */
type Sealed = {
  salt: string; // hex
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
};

type KeystoreFile = {
  version: 1;
  address: `0x${string}`;
  /** The private key. Shape kept stable so older keystores keep opening. */
  crypto: { kdf: "scrypt"; n: number } & Sealed;
  /** Present only when the wallet was created from a BIP-39 phrase. */
  mnemonic?: Sealed;
};

const SCRYPT_N = 1 << 15; // 32768

/** Standard Ethereum account path, so the same phrase opens in MetaMask or Rabby. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // maxmem must exceed 128 * N * r bytes (~32MB at N=2^15); give headroom.
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function seal(plaintext: Buffer, passphrase: string): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

function unseal(s: Sealed, passphrase: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, Buffer.from(s.salt, "hex")), Buffer.from(s.iv, "hex"));
  decipher.setAuthTag(Buffer.from(s.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "hex")), decipher.final()]);
  } catch {
    throw new Error("Wrong passphrase.");
  }
}

export function keystoreExists(): boolean {
  return existsSync(KEYSTORE_PATH);
}

function readFile(): KeystoreFile {
  if (!keystoreExists()) throw new Error("No keystore. Run `cowl init` first.");
  return JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
}

function normalizePk(pk: string): `0x${string}` {
  const v = pk.startsWith("0x") ? pk : `0x${pk}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid private key (need 32-byte hex).");
  return v as `0x${string}`;
}

/** Encrypt a private key (and optionally its phrase) and write the keystore (0600). */
export function writeKeystore(privateKey: `0x${string}`, passphrase: string, mnemonic?: string): `0x${string}` {
  const account = privateKeyToAccount(privateKey);
  const pkSealed = seal(Buffer.from(privateKey.slice(2), "hex"), passphrase);

  const file: KeystoreFile = {
    version: 1,
    address: account.address,
    crypto: { kdf: "scrypt", n: SCRYPT_N, ...pkSealed },
    ...(mnemonic ? { mnemonic: seal(Buffer.from(mnemonic, "utf8"), passphrase) } : {}),
  };

  ensureHome();
  writeFileSync(KEYSTORE_PATH, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return account.address;
}

export function createKeystore(passphrase: string): `0x${string}` {
  return writeKeystore(generatePrivateKey(), passphrase);
}

export function importKeystore(privateKey: string, passphrase: string): `0x${string}` {
  return writeKeystore(normalizePk(privateKey), passphrase);
}

// ---- BIP-39 phrases ---------------------------------------------------------

/** A fresh 12-word phrase. */
export function newMnemonic(): string {
  return generateMnemonic(english);
}

/** The private key a phrase derives at the standard account path. */
function privateKeyFromMnemonic(mnemonic: string): `0x${string}` {
  let account;
  try {
    account = mnemonicToAccount(mnemonic.trim(), { path: DERIVATION_PATH });
  } catch {
    throw new Error("That is not a valid BIP-39 phrase. Check the spelling and word order.");
  }
  const hd = account.getHdKey();
  if (!hd.privateKey) throw new Error("Could not derive a key from that phrase.");
  return `0x${Buffer.from(hd.privateKey).toString("hex")}` as `0x${string}`;
}

/** Create a wallet from a phrase, storing the phrase so it can be shown again. */
export function importMnemonic(mnemonic: string, passphrase: string): `0x${string}` {
  const trimmed = mnemonic.trim().replace(/\s+/g, " ");
  return writeKeystore(privateKeyFromMnemonic(trimmed), passphrase, trimmed);
}

export function hasMnemonic(): boolean {
  try {
    return readFile().mnemonic !== undefined;
  } catch {
    return false;
  }
}

/** Reveal the stored phrase, or null when the wallet was made from a raw key. */
export function exportMnemonic(passphrase: string): string | null {
  const file = readFile();
  // Validate the passphrase against the key even when there is no phrase.
  unseal(file.crypto, passphrase);
  if (!file.mnemonic) return null;
  return unseal(file.mnemonic, passphrase).toString("utf8");
}

// ---- reads ------------------------------------------------------------------

/** Read the stored address without decrypting. */
export function keystoreAddress(): `0x${string}` | null {
  if (!keystoreExists()) return null;
  try {
    return readFile().address;
  } catch {
    return null;
  }
}

/** Decrypt the keystore into a usable account. Throws on a bad passphrase. */
export function unlockKeystore(passphrase: string): PrivateKeyAccount {
  const plain = unseal(readFile().crypto, passphrase);
  return privateKeyToAccount(`0x${plain.toString("hex")}` as `0x${string}`);
}

/** Decrypt and return the raw private key (for `wallet export`). */
export function exportPrivateKey(passphrase: string): `0x${string}` {
  return `0x${unseal(readFile().crypto, passphrase).toString("hex")}` as `0x${string}`;
}

/** Re-encrypt the key, and any stored phrase, under a new passphrase. */
export function changePassphrase(oldPass: string, newPass: string): `0x${string}` {
  const file = readFile();
  const privateKey = `0x${unseal(file.crypto, oldPass).toString("hex")}` as `0x${string}`;
  const mnemonic = file.mnemonic ? unseal(file.mnemonic, oldPass).toString("utf8") : undefined;
  return writeKeystore(privateKey, newPass, mnemonic);
}
