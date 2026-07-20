// View keys for selective disclosure. An ed25519 keypair whose public half you
// can hand to an auditor or tax authority so they can read what you grant —
// and nothing else. The private half never leaves ~/.cowl.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import { VIEWKEY_PATH, ensureHome } from "./paths.js";

type ViewKeyFile = {
  version: 1;
  createdAt: string;
  privateKey: string; // hex
  publicKey: string; // hex
};

export type ViewKey = { publicKey: string; createdAt: string };

export function viewKeyExists(): boolean {
  return existsSync(VIEWKEY_PATH);
}

export function createViewKey(nowIso: string): ViewKey {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const file: ViewKeyFile = {
    version: 1,
    createdAt: nowIso,
    privateKey: bytesToHex(priv),
    publicKey: bytesToHex(pub),
  };
  ensureHome();
  writeFileSync(VIEWKEY_PATH, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return { publicKey: "0x" + file.publicKey, createdAt: file.createdAt };
}

export function readViewKey(): ViewKey | null {
  if (!viewKeyExists()) return null;
  try {
    const file = JSON.parse(readFileSync(VIEWKEY_PATH, "utf8")) as ViewKeyFile;
    return { publicKey: "0x" + file.publicKey, createdAt: file.createdAt };
  } catch {
    return null;
  }
}
