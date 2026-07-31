import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, ensureHome } from "./paths.js";
import { NETWORKS, DEFAULT_NETWORK, type NetworkDef, type CowlContracts } from "./networks.js";
import type { AccountSpace } from "./shielded/keys.js";

export type Config = {
  network: string;
  /**
   * Which shielded account this profile operates — see AccountSpace in
   * shielded/keys.ts. Not per-network: one wallet's choice of book holds
   * wherever it goes. Absent means "key", the terminal's own account.
   */
  shieldedAccount?: AccountSpace;
  // Per-network overrides keyed by network key.
  overrides: Record<
    string,
    Partial<Pick<NetworkDef, "rpcUrl" | "chainId" | "explorer">> & {
      contracts?: CowlContracts;
      /** ERC-20 addresses to include in `cowl portfolio`. */
      tokens?: string[];
    }
  >;
};

const DEFAULT_CONFIG: Config = {
  network: DEFAULT_NETWORK,
  overrides: {},
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    return {
      network: raw.network ?? DEFAULT_NETWORK,
      ...(raw.shieldedAccount ? { shieldedAccount: raw.shieldedAccount } : {}),
      overrides: raw.overrides ?? {},
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** The active network with any user overrides merged in. */
export function activeNetwork(cfg: Config): NetworkDef {
  const base = NETWORKS[cfg.network];
  if (!base) {
    throw new Error(
      `Unknown network "${cfg.network}". Known: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  const ov = cfg.overrides[cfg.network] ?? {};
  return {
    ...base,
    // Pinning an RPC means that one and no other — a relayer pins deliberately,
    // and silently falling back to a public endpoint would undo the choice.
    ...(ov.rpcUrl !== undefined ? { rpcUrl: ov.rpcUrl, rpcFallbacks: undefined } : {}),
    ...(ov.chainId !== undefined ? { chainId: ov.chainId } : {}),
    ...(ov.explorer !== undefined ? { explorer: ov.explorer } : {}),
    contracts: { ...base.contracts, ...(ov.contracts ?? {}) },
  };
}

/** ERC-20 addresses tracked in the portfolio for the active network. */
export function trackedTokens(cfg: Config): string[] {
  return cfg.overrides[cfg.network]?.tokens ?? [];
}

export function addTrackedToken(cfg: Config, address: string): Config {
  const netKey = cfg.network;
  const ov = { ...(cfg.overrides[netKey] ?? {}) };
  const lower = address.toLowerCase();
  const list = (ov.tokens ?? []).filter((t) => t.toLowerCase() !== lower);
  ov.tokens = [...list, address];
  return { ...cfg, overrides: { ...cfg.overrides, [netKey]: ov } };
}

export function removeTrackedToken(cfg: Config, address: string): Config {
  const netKey = cfg.network;
  const ov = { ...(cfg.overrides[netKey] ?? {}) };
  const lower = address.toLowerCase();
  ov.tokens = (ov.tokens ?? []).filter((t) => t.toLowerCase() !== lower);
  return { ...cfg, overrides: { ...cfg.overrides, [netKey]: ov } };
}

/** Apply a dotted-path set like `network.rpcUrl` or `contracts.pool`. */
export function setConfigValue(cfg: Config, key: string, value: string): Config {
  const netKey = cfg.network;
  const ov = { ...(cfg.overrides[netKey] ?? {}) };

  switch (key) {
    case "network.rpcUrl":
    case "rpcUrl":
      ov.rpcUrl = value;
      break;
    case "network.chainId":
    case "chainId":
      ov.chainId = Number(value);
      break;
    case "network.explorer":
    case "explorer":
      ov.explorer = value;
      break;
    case "contracts.pool":
    case "contracts.relayer": {
      const which = key.split(".")[1] as keyof CowlContracts;
      ov.contracts = { ...(ov.contracts ?? {}), [which]: value as `0x${string}` };
      break;
    }
    // Not a network override: which book this wallet operates travels with it.
    case "shieldedAccount": {
      if (value !== "key" && value !== "sig-v1") {
        throw new Error(`shieldedAccount is "key" (the terminal's own) or "sig-v1" (the browser app's), not "${value}".`);
      }
      return { ...cfg, shieldedAccount: value };
    }
    default:
      throw new Error(
        `Unknown config key "${key}". Try: shieldedAccount, rpcUrl, chainId, explorer, contracts.pool, contracts.relayer`,
      );
  }

  return { ...cfg, overrides: { ...cfg.overrides, [netKey]: ov } };
}

/**
 * Drop an override so the network's own default takes over again.
 *
 * An override outlives whatever made it: an RPC pinned at an ssh tunnel keeps
 * being the RPC long after the tunnel dies, and every read then fails with
 * nothing on screen pointing at the reason. Undoing one meant editing the JSON.
 */
export function unsetConfigValue(cfg: Config, key: string): Config {
  const netKey = cfg.network;
  const ov = { ...(cfg.overrides[netKey] ?? {}) };

  switch (key) {
    case "network.rpcUrl":
    case "rpcUrl":
      delete ov.rpcUrl;
      break;
    case "network.chainId":
    case "chainId":
      delete ov.chainId;
      break;
    case "network.explorer":
    case "explorer":
      delete ov.explorer;
      break;
    case "contracts.pool":
    case "contracts.relayer": {
      const which = key.split(".")[1] as keyof CowlContracts;
      const contracts = { ...(ov.contracts ?? {}) };
      delete contracts[which];
      ov.contracts = contracts;
      break;
    }
    case "shieldedAccount": {
      const next = { ...cfg };
      delete next.shieldedAccount;
      return next;
    }
    default:
      throw new Error(
        `Unknown config key "${key}". Try: shieldedAccount, rpcUrl, chainId, explorer, contracts.pool, contracts.relayer`,
      );
  }

  return { ...cfg, overrides: { ...cfg.overrides, [netKey]: ov } };
}
