import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export const COWL_DIR = process.env.COWL_HOME ?? join(homedir(), ".cowl");
export const CONFIG_PATH = join(COWL_DIR, "config.json");
export const KEYSTORE_PATH = join(COWL_DIR, "keystore.json");
export const VIEWKEY_PATH = join(COWL_DIR, "viewkey.json");
export const STEALTH_PATH = join(COWL_DIR, "stealth.json");

/** Home directory replaced with ~ for display, so shown paths don't leak the username. */
export function displayPath(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

/** Ensure ~/.cowl exists with private (0700) permissions. */
export function ensureHome(): void {
  if (!existsSync(COWL_DIR)) {
    mkdirSync(COWL_DIR, { recursive: true, mode: 0o700 });
  }
}
