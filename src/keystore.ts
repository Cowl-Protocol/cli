import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { KEYSTORE_PATH, ensureHome } from "./paths.js";

type KeystoreFile = {
  version: 1;
  address: `0x${string}`;
  crypto: {
    kdf: "scrypt";
    n: number;
    salt: string; // hex
    iv: string; // hex
    tag: string; // hex
    ciphertext: string; // hex
  };
};

const SCRYPT_N = 1 << 15; // 32768

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // maxmem must exceed 128 * N * r bytes (~32MB at N=2^15); give headroom.
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function keystoreExists(): boolean {
  return existsSync(KEYSTORE_PATH);
}

function normalizePk(pk: string): `0x${string}` {
  const v = pk.startsWith("0x") ? pk : `0x${pk}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid private key (need 32-byte hex).");
  return v as `0x${string}`;
}

/** Encrypt a private key under a passphrase and write the keystore (0600). */
export function writeKeystore(privateKey: `0x${string}`, passphrase: string): `0x${string}` {
  const account = privateKeyToAccount(privateKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), "hex")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const file: KeystoreFile = {
    version: 1,
    address: account.address,
    crypto: {
      kdf: "scrypt",
      n: SCRYPT_N,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    },
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

/** Read the stored address without decrypting. */
export function keystoreAddress(): `0x${string}` | null {
  if (!keystoreExists()) return null;
  try {
    const file = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
    return file.address;
  } catch {
    return null;
  }
}

/** Decrypt the keystore into a usable account. Throws on a bad passphrase. */
export function unlockKeystore(passphrase: string): PrivateKeyAccount {
  if (!keystoreExists()) throw new Error("No keystore. Run `cowl init` first.");
  const file = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
  const { salt, iv, tag, ciphertext } = file.crypto;
  const key = deriveKey(passphrase, Buffer.from(salt, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]);
  } catch {
    throw new Error("Wrong passphrase.");
  }
  const pk = `0x${plain.toString("hex")}` as `0x${string}`;
  return privateKeyToAccount(pk);
}

/** Re-encrypt the same key under a new passphrase. Throws if the old one is wrong. */
export function changePassphrase(oldPass: string, newPass: string): `0x${string}` {
  const privateKey = exportPrivateKey(oldPass);
  return writeKeystore(privateKey, newPass);
}

/** Decrypt and return the raw private key (for `wallet export`). */
export function exportPrivateKey(passphrase: string): `0x${string}` {
  const account = unlockKeystore(passphrase);
  // Re-read plaintext directly (unlockKeystore validated the passphrase).
  const file = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
  const { salt, iv, tag, ciphertext } = file.crypto;
  const key = deriveKey(passphrase, Buffer.from(salt, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]);
  void account;
  return `0x${plain.toString("hex")}` as `0x${string}`;
}
