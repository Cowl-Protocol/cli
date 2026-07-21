// Encrypted backup of everything that cannot be recomputed.
//
// The keystore is your wallet and the view key is generated randomly, so neither
// can be derived from anything else — lose them and they are gone. Shielded notes
// are deliberately left out: every note key descends from the wallet key, so a
// rescan rebuilds them from the pool. The whole bundle is sealed under its own
// passphrase (scrypt + AES-256-GCM) so a backup is safe to keep off the machine.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { CONFIG_PATH, KEYSTORE_PATH, VIEWKEY_PATH, ensureHome } from "./paths.js";

const SCRYPT_N = 1 << 15;

type Payload = {
  keystore: unknown;
  viewkey: unknown | null;
  config: unknown | null;
};

export type BackupFile = {
  format: "cowl-backup";
  version: 1;
  createdAt: string;
  address: string | null;
  crypto: { kdf: "scrypt"; n: number; salt: string; iv: string; tag: string; ciphertext: string };
};

export type BackupContents = {
  createdAt: string;
  address: string | null;
  hasViewKey: boolean;
  hasConfig: boolean;
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Seal keystore + view key + config into one encrypted file. */
export function createBackup(path: string, passphrase: string, nowIso: string): BackupContents {
  const keystore = readJson(KEYSTORE_PATH);
  if (!keystore) throw new Error("No wallet to back up. Run `cowl init` first.");
  const viewkey = readJson(VIEWKEY_PATH);
  const config = readJson(CONFIG_PATH);

  const payload: Payload = { keystore, viewkey, config };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);

  const address = (keystore as { address?: string }).address ?? null;
  const file: BackupFile = {
    format: "cowl-backup",
    version: 1,
    createdAt: nowIso,
    address,
    crypto: {
      kdf: "scrypt",
      n: SCRYPT_N,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    },
  };

  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return { createdAt: nowIso, address, hasViewKey: viewkey !== null, hasConfig: config !== null };
}

function openBackup(path: string, passphrase: string): { file: BackupFile; payload: Payload } {
  if (!existsSync(path)) throw new Error(`No backup at ${path}`);
  let file: BackupFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as BackupFile;
  } catch {
    throw new Error("That file is not readable as a Cowl backup.");
  }
  if (file.format !== "cowl-backup") throw new Error("That file is not a Cowl backup.");

  const { salt, iv, tag, ciphertext } = file.crypto;
  const key = deriveKey(passphrase, Buffer.from(salt, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]);
  } catch {
    throw new Error("Wrong backup passphrase.");
  }
  return { file, payload: JSON.parse(plain.toString("utf8")) as Payload };
}

/** Decrypt and report what a backup holds, without writing anything. */
export function verifyBackup(path: string, passphrase: string): BackupContents {
  const { file, payload } = openBackup(path, passphrase);
  return {
    createdAt: file.createdAt,
    address: file.address,
    hasViewKey: payload.viewkey !== null,
    hasConfig: payload.config !== null,
  };
}

/** Write a backup's contents back into the Cowl home directory. */
export function restoreBackup(path: string, passphrase: string): BackupContents {
  const { file, payload } = openBackup(path, passphrase);
  ensureHome();
  writeFileSync(KEYSTORE_PATH, JSON.stringify(payload.keystore, null, 2) + "\n", { mode: 0o600 });
  if (payload.viewkey) writeFileSync(VIEWKEY_PATH, JSON.stringify(payload.viewkey, null, 2) + "\n", { mode: 0o600 });
  if (payload.config) writeFileSync(CONFIG_PATH, JSON.stringify(payload.config, null, 2) + "\n", { mode: 0o600 });
  return {
    createdAt: file.createdAt,
    address: file.address,
    hasViewKey: payload.viewkey !== null,
    hasConfig: payload.config !== null,
  };
}
