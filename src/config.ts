import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_PATH, ensureHome } from "./paths.js";
import { NETWORKS, DEFAULT_NETWORK, type NetworkDef, type CowlContracts } from "./networks.js";

export type Config = {
  network: string;
  // Per-network overrides keyed by network key.
  overrides: Record<
    string,
    Partial<Pick<NetworkDef, "rpcUrl" | "chainId" | "explorer">> & { contracts?: CowlContracts }
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
    ...(ov.rpcUrl !== undefined ? { rpcUrl: ov.rpcUrl } : {}),
    ...(ov.chainId !== undefined ? { chainId: ov.chainId } : {}),
    ...(ov.explorer !== undefined ? { explorer: ov.explorer } : {}),
    contracts: { ...base.contracts, ...(ov.contracts ?? {}) },
  };
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
    case "contracts.relayer":
    case "contracts.staking": {
      const which = key.split(".")[1] as keyof CowlContracts;
      ov.contracts = { ...(ov.contracts ?? {}), [which]: value as `0x${string}` };
      break;
    }
    default:
      throw new Error(
        `Unknown config key "${key}". Try: rpcUrl, chainId, explorer, contracts.pool, contracts.relayer, contracts.staking`,
      );
  }

  return { ...cfg, overrides: { ...cfg.overrides, [netKey]: ov } };
}
