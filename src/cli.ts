import { Command } from "commander";
import * as p from "@clack/prompts";
import { isAddress, parseEther, formatEther, type Address } from "viem";
import {
  acid,
  bone,
  muted,
  dim,
  bold,
  banner,
  ok,
  warn,
  row,
  heading,
  die,
  symbols,
} from "./ui.js";
import { statSync } from "node:fs";
import { COWL_DIR, CONFIG_PATH, KEYSTORE_PATH, VIEWKEY_PATH, displayPath } from "./paths.js";
import { createBackup, verifyBackup, restoreBackup } from "./backup.js";
import { passphraseStrength } from "./strength.js";
import {
  loadConfig,
  saveConfig,
  activeNetwork,
  setConfigValue,
  trackedTokens,
  addTrackedToken,
  removeTrackedToken,
  type Config,
} from "./config.js";
import { NETWORKS, type NetworkDef, type CowlContracts } from "./networks.js";
import {
  keystoreExists,
  keystoreAddress,
  createKeystore,
  importKeystore,
  exportPrivateKey,
  changePassphrase,
  newMnemonic,
  importMnemonic,
  exportMnemonic,
  hasMnemonic,
  DERIVATION_PATH,
} from "./keystore.js";
import {
  nativeBalance,
  tokenBalance,
  tokenInfo,
  tokenMeta,
  sendNative,
  sendToken,
  waitForReceipt,
  publicClient,
} from "./chain.js";
import { deriveMetaKeys, generateStealthAddress } from "./stealth.js";
import { createViewKey, readViewKey, viewKeyExists } from "./viewkey.js";
import { FEES, FEE_SPLIT } from "./fees.js";
import { FAUCETS } from "./faucets.js";
import { logo } from "./logo.js";
import { deriveShieldedKeys, decodePaymentAddress, isPaymentAddress, type ShieldedKeys } from "./shielded/keys.js";
import { tokenToField, tokenLabel } from "./shielded/note.js";
import { shield as poolShield, unshield as poolUnshield, sendPrivate, balance as poolBalance, scan as poolScan, trade as poolTrade } from "./shielded/pool.js";
import { MARKETS, PROTOCOL_FEE_BPS, QUOTE_SYMBOL, WAD, priceInQuoteWad, quoteTrade, type Side } from "./shielded/market.js";

/** The wordmark needs ~35 columns; fall back to the compact banner when narrow. */
function splash(): string {
  return (process.stdout.columns ?? 0) >= 38 ? logo() : banner();
}

// Replaced at build time from package.json (see build.mjs); `dev` fallback otherwise.
const VERSION = process.env.COWL_VERSION ?? "0.0.0-dev";

const program = new Command();
program
  .name("cowl")
  .description("Cowl Protocol — private trading on Robinhood Chain, from your terminal.")
  .version(VERSION, "-v, --version", "print version")
  .option("-n, --network <key>", "network for this command")
  .option("--rpc <url>", "override RPC URL for this command")
  .option("--json", "machine-readable JSON output")
  .configureHelp({ sortSubcommands: true });

// ---- shared helpers ---------------------------------------------------------

type Ctx = { cfg: Config; net: NetworkDef; json: boolean };

function ctx(): Ctx {
  const opts = program.opts<{ network?: string; rpc?: string; json?: boolean }>();
  const cfg = loadConfig();
  if (opts.network) {
    if (!NETWORKS[opts.network]) die(`Unknown network "${opts.network}".`, `Known: ${Object.keys(NETWORKS).join(", ")}`);
    cfg.network = opts.network;
  }
  let net = activeNetwork(cfg);
  if (opts.rpc) net = { ...net, rpcUrl: opts.rpc };
  return { cfg, net, json: !!opts.json };
}

function requireWallet(): Address {
  const addr = keystoreAddress();
  if (!addr) die("No wallet found.", "Create one: cowl init");
  return addr;
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
  return value;
}

function askPassphrase(message = "Keystore passphrase"): Promise<string> {
  // Non-interactive escape hatch for scripting/CI. Never echoed.
  const env = process.env.COWL_PASSPHRASE;
  if (env) return Promise.resolve(env);
  return p.password({ message }).then(unwrap);
}

function txLink(net: NetworkDef, hash: string): string {
  return net.explorer ? `${net.explorer}/tx/${hash}` : hash;
}

function out(json: boolean, obj: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else human();
}

/** Print a seed phrase as a numbered grid, with the warnings it deserves. */
function revealMnemonic(mnemonic: string): void {
  const words = mnemonic.split(" ");
  heading("Your seed phrase");
  const perRow = 4;
  for (let i = 0; i < words.length; i += perRow) {
    const cells = words.slice(i, i + perRow).map((w, j) => `${muted(String(i + j + 1).padStart(2))} ${bold(bone(w.padEnd(9)))}`);
    console.log(`  ${cells.join(" ")}`);
  }
  console.log(`\n  ${warnMark()} ${bold("Write these words down, in order, on paper.")}`);
  console.log(`  ${muted("Anyone holding this phrase owns the wallet. Nobody can recover it for you.")}`);
  console.log(`  ${muted(`Opens in any wallet at ${DERIVATION_PATH}.`)}`);
}

/** Pick how a new wallet should be backed up. */
async function chooseWalletMode(opts: { key?: boolean; mnemonic?: boolean }): Promise<"mnemonic" | "key"> {
  if (opts.key) return "key";
  if (opts.mnemonic) return "mnemonic";
  if (process.env.COWL_PASSPHRASE) return "mnemonic";
  const sel = await p.select({
    message: "How do you want to back this wallet up?",
    options: [
      { value: "mnemonic", label: "Seed phrase (12 words)", hint: "recommended · opens in MetaMask or Rabby" },
      { value: "key", label: "Private key only", hint: "no phrase, and none can be added later" },
    ],
  });
  return unwrap(sel) as "mnemonic" | "key";
}

/** Ask for a new passphrase and push back on weak ones before they seal anything. */
async function askNewPassphrase(message: string): Promise<string> {
  const pass = await askPassphrase(message);
  const s = passphraseStrength(pass);
  if (s.level !== "strong") {
    warn(`That passphrase looks ${s.level}.`);
    if (s.hint) console.log(`  ${muted(s.hint)}`);
    console.log(`  ${muted("A stolen keystore is attacked offline, where short passphrases fall fast.")}`);
    if (!process.env.COWL_PASSPHRASE) {
      const go = unwrap(await p.confirm({ message: "Use it anyway?", initialValue: false }));
      if (!go) die("Cancelled.", "Nothing was written.");
    }
  }
  return pass;
}

/** Unlock the wallet and derive the shielded-pool keys. */
async function shieldedKeys(): Promise<ShieldedKeys> {
  requireWallet();
  const pass = await askPassphrase();
  const pk = exportPrivateKey(pass);
  return deriveShieldedKeys(pk);
}

/** Until the pool contract deploys, shielded ops are a local, off-chain simulation. */
function localNotice(net: NetworkDef): void {
  if (net.contracts.pool) return;
  console.log(
    `\n  ${warnMark()} ${muted("Local shielded pool — no contract on")} ${bone(net.label)} ${muted("yet, so this is recorded off-chain only. Real on-chain privacy lights up when the pool deploys.")}`,
  );
}
const warnMark = () => acid("!");

/** Feature that needs on-chain Cowl contracts that aren't deployed yet. */
function pending(feature: string, which: keyof CowlContracts, net: NetworkDef): never {
  warn(`${feature} is not live on ${bone(net.label)} yet.`);
  console.log(
    `  ${muted(
      `The Cowl protocol contracts are not deployed on public networks yet — this CLI is testnet-first.`,
    )}`,
  );
  console.log(
    `  ${muted(`Once deployed:`)} ${dim(`cowl config set contracts.${which} 0x…`)}`,
  );
  process.exit(0);
}

// ---- init -------------------------------------------------------------------

program
  .command("init")
  .description("set up your wallet, view key, and network")
  .option("--force", "overwrite an existing wallet")
  .action(async (opts: { force?: boolean }) => {
    console.log(splash());
    p.intro(acid("Set up Cowl"));

    if (keystoreExists() && !opts.force) {
      const go = unwrap(await 
        p.confirm({ message: "A wallet already exists. Overwrite it?", initialValue: false }),
      );
      if (!go) {
        p.outro(muted("Kept your existing wallet."));
        return;
      }
    }

    const modeSel = await p.select({
      message: "Wallet",
      options: [
        { value: "new-seed", label: "Create a new wallet", hint: "seed phrase · recommended" },
        { value: "new-key", label: "Create a new wallet", hint: "private key only" },
        { value: "import-seed", label: "Import a seed phrase" },
        { value: "import-key", label: "Import a private key" },
      ],
    });
    const mode = unwrap(modeSel) as string;

    let secret: string | undefined;
    if (mode === "import-key") {
      secret = unwrap(await p.text({ message: "Private key (0x…)", validate: (v) => (/^0x?[0-9a-fA-F]{64}$/.test(v.trim()) ? undefined : "Need a 32-byte hex key.") }));
    } else if (mode === "import-seed") {
      secret = unwrap(
        await p.text({
          message: "Seed phrase (12 or 24 words)",
          validate: (v) => {
            const n = v.trim().split(/\s+/).length;
            return n === 12 || n === 24 ? undefined : "A BIP-39 phrase is 12 or 24 words.";
          },
        }),
      );
    }

    const pass = await askNewPassphrase("Choose a passphrase (encrypts your key)");
    const pass2 = await askPassphrase("Confirm passphrase");
    if (pass !== pass2) die("Passphrases do not match.");

    const netSel = await p.select({
      message: "Network",
      options: Object.values(NETWORKS).map((n) => ({
        value: n.key,
        label: n.label,
        hint: n.rpcUrl ? undefined : "RPC not set",
      })),
    });
    const netKey = unwrap(netSel) as string;

    let generated: string | undefined;
    let address: `0x${string}`;
    try {
      switch (mode) {
        case "new-seed":
          generated = newMnemonic();
          address = importMnemonic(generated, pass);
          break;
        case "new-key":
          address = createKeystore(pass);
          break;
        case "import-seed":
          address = importMnemonic(secret!, pass);
          break;
        default:
          address = importKeystore(secret!, pass);
      }
    } catch (e) {
      die((e as Error).message);
    }

    const cfg = loadConfig();
    cfg.network = netKey;
    saveConfig(cfg);

    if (!viewKeyExists()) createViewKey(new Date().toISOString());

    p.outro(`${symbols.ok()} ${bold("Ready.")}`);
    if (generated) revealMnemonic(generated);
    row("Address", acid(address));
    row("Network", bone(NETWORKS[netKey]!.label));
    row("Stored in", muted(displayPath(COWL_DIR)));
    const next = NETWORKS[netKey]!.testnet
      ? `${dim("cowl faucet")} ${muted("·")} ${dim("cowl balance")} ${muted("·")} ${dim("cowl address")}`
      : `${dim("cowl balance")} ${muted("·")} ${dim("cowl address")} ${muted("·")} ${dim("cowl fees")}`;
    console.log(`\n  ${muted("Next:")} ${next}`);
  });

// ---- wallet -----------------------------------------------------------------

const wallet = program.command("wallet").description("manage your local wallet");

wallet
  .command("new")
  .description("create a new wallet, backed by a seed phrase or a private key")
  .option("--force", "overwrite an existing wallet")
  .option("--mnemonic", "back it with a 12-word seed phrase")
  .option("--key", "back it with a private key only")
  .action(async (opts: { force?: boolean; mnemonic?: boolean; key?: boolean }) => {
    if (keystoreExists() && !opts.force) die("A wallet already exists.", "Overwrite: cowl wallet new --force");
    if (opts.mnemonic && opts.key) die("Pick one of --mnemonic or --key.");
    const mode = await chooseWalletMode(opts);
    const pass = await askNewPassphrase("Choose a passphrase");
    const pass2 = await askPassphrase("Confirm passphrase");
    if (pass !== pass2) die("Passphrases do not match.");

    if (mode === "key") {
      const address = createKeystore(pass);
      ok(`New wallet: ${acid(address)}`);
      console.log(`  ${muted("Private key only. Back it up with")} ${dim("cowl backup <path>")}`);
      return;
    }
    const phrase = newMnemonic();
    const address = importMnemonic(phrase, pass);
    ok(`New wallet: ${acid(address)}`);
    revealMnemonic(phrase);
  });

wallet
  .command("import")
  .description("import a private key or a seed phrase")
  .argument("[secret]", "private key or seed phrase (prompted if omitted)")
  .option("--force", "overwrite an existing wallet")
  .option("--mnemonic", "treat the argument as a seed phrase")
  .action(async (secretArg: string | undefined, opts: { force?: boolean; mnemonic?: boolean }) => {
    if (keystoreExists() && !opts.force) die("A wallet already exists.", "Overwrite: cowl wallet import --force");
    const secret =
      secretArg ??
      unwrap(await p.text({ message: opts.mnemonic ? "Seed phrase (12 or 24 words)" : "Private key (0x…)" }));
    // A phrase is unambiguous: private keys are a single hex blob.
    const isPhrase = opts.mnemonic || secret.trim().split(/\s+/).length > 1;
    const pass = await askNewPassphrase("Choose a passphrase");
    try {
      const address = isPhrase ? importMnemonic(secret, pass) : importKeystore(secret, pass);
      ok(`Imported: ${acid(address)}`);
      if (isPhrase) console.log(`  ${muted(`Derived at ${DERIVATION_PATH}`)}`);
    } catch (e) {
      die((e as Error).message);
    }
  });

wallet
  .command("address")
  .description("print your wallet address")
  .action(() => {
    const addr = requireWallet();
    const { json } = ctx();
    out(json, { address: addr }, () => console.log(acid(addr)));
  });

wallet
  .command("export")
  .description("reveal your private key, or --mnemonic for your seed phrase (dangerous)")
  .option("-m, --mnemonic", "show the seed phrase instead of the private key")
  .action(async (opts: { mnemonic?: boolean }) => {
    requireWallet();
    if (opts.mnemonic && !hasMnemonic()) {
      warn("This wallet has no seed phrase.");
      console.log(`  ${muted("It was created from a raw private key, and a key cannot be turned back into a phrase.")}`);
      console.log(`  ${muted("Export the key instead:")} ${dim("cowl wallet export")}`);
      console.log(`  ${muted("Want a phrase? Create a new wallet and move your funds:")} ${dim("cowl wallet new --mnemonic")}`);
      return;
    }

    warn(`This prints your ${opts.mnemonic ? "seed phrase" : "private key"} in plaintext.`);
    console.log(`  ${muted("Not while screen sharing or recording. Once it is captured, treat the wallet as burned.")}`);
    const go = unwrap(await p.confirm({ message: "Continue?", initialValue: false }));
    if (!go) return;
    const pass = await askPassphrase();

    try {
      if (opts.mnemonic) {
        const phrase = exportMnemonic(pass);
        if (!phrase) die("No seed phrase stored for this wallet.");
        revealMnemonic(phrase);
      } else {
        console.log(`\n  ${bold(exportPrivateKey(pass))}\n`);
        warn("Anyone with this key controls your funds. Never share it.");
      }
      console.log(`  ${muted("Prefer")} ${dim("cowl backup <path>")} ${muted("— it stays encrypted at rest.")}`);
    } catch (e) {
      die((e as Error).message);
    }
  });

wallet
  .command("passphrase")
  .description("change the passphrase protecting your keystore")
  .action(async () => {
    requireWallet();
    const current = await askPassphrase("Current passphrase");
    const next = await askNewPassphrase("New passphrase");
    const confirm = await askPassphrase("Confirm new passphrase");
    if (next !== confirm) die("Passphrases do not match.", "Nothing was changed.");
    try {
      const address = changePassphrase(current, next);
      ok(`Passphrase changed for ${acid(address)}`);
      console.log(`  ${muted("Existing backups still use the old passphrase. Make a fresh one:")} ${dim("cowl backup <path>")}`);
    } catch (e) {
      die((e as Error).message);
    }
  });

// ---- backup / restore -------------------------------------------------------

program
  .command("backup")
  .description("write an encrypted backup of your wallet and view key")
  .argument("<path>", "file to write, e.g. ~/cowl-backup.json")
  .option("--verify", "check an existing backup instead of writing one")
  .action(async (path: string, opts: { verify?: boolean }) => {
    if (opts.verify) {
      const pass = await askPassphrase("Backup passphrase");
      try {
        const info = verifyBackup(path, pass);
        ok("Backup opens and is intact.");
        row("Address", acid(info.address ?? dim("unknown")));
        row("Created", muted(info.createdAt));
        row("View key", info.hasViewKey ? `${symbols.ok()} ${muted("included")}` : dim("missing"));
        row("Config", info.hasConfig ? `${symbols.ok()} ${muted("included")}` : dim("missing"));
      } catch (e) {
        die((e as Error).message);
      }
      return;
    }

    requireWallet();
    console.log(`  ${muted("This backup is sealed under its own passphrase, separate from your keystore.")}`);
    const pass = await askNewPassphrase("Passphrase for this backup");
    const confirm = await askPassphrase("Confirm backup passphrase");
    if (pass !== confirm) die("Passphrases do not match.", "Nothing was written.");

    try {
      const info = createBackup(path, pass, new Date().toISOString());
      ok(`Backup written to ${bone(path)}`);
      row("Address", acid(info.address ?? dim("unknown")));
      row("View key", info.hasViewKey ? `${symbols.ok()} ${muted("included")}` : dim("none on this machine"));
      row("Config", info.hasConfig ? `${symbols.ok()} ${muted("included")}` : dim("none"));
      console.log(
        `\n  ${muted("Shielded notes are left out on purpose — every note key descends from your wallet key, so")} ${dim("cowl scan")} ${muted("rebuilds them.")}`,
      );
      console.log(`  ${muted("Verify it before you trust it:")} ${dim(`cowl backup --verify ${path}`)}`);
    } catch (e) {
      die((e as Error).message);
    }
  });

program
  .command("restore")
  .description("restore a wallet and view key from an encrypted backup")
  .argument("<path>", "backup file")
  .option("--force", "overwrite the wallet on this machine")
  .action(async (path: string, opts: { force?: boolean }) => {
    if (keystoreExists() && !opts.force) {
      warn("A wallet already exists on this machine.");
      const go = unwrap(await p.confirm({ message: "Overwrite it?", initialValue: false }));
      if (!go) {
        console.log(muted("  Kept your existing wallet."));
        return;
      }
    }
    const pass = await askPassphrase("Backup passphrase");
    try {
      const info = restoreBackup(path, pass);
      ok(`Restored ${acid(info.address ?? "wallet")}`);
      row("From", muted(path));
      row("Created", muted(info.createdAt));
      console.log(`\n  ${muted("Rebuild your shielded notes:")} ${dim("cowl scan")}`);
    } catch (e) {
      die((e as Error).message);
    }
  });

// ---- doctor -----------------------------------------------------------------

program
  .command("doctor")
  .description("check your local setup for security and configuration problems")
  .action(() => {
    const { json } = ctx();
    type Check = { name: string; ok: boolean; detail: string };
    const checks: Check[] = [];

    const modeOf = (path: string): number | null => {
      try {
        return statSync(path).mode & 0o777;
      } catch {
        return null;
      }
    };

    const dirMode = modeOf(COWL_DIR);
    checks.push({
      name: "Data directory",
      ok: dirMode === 0o700,
      detail: dirMode === null ? "missing" : dirMode === 0o700 ? "0700, private" : `${dirMode.toString(8)}, should be 0700`,
    });

    // Config is optional — defaults apply when it is absent. The keystore and the
    // view key are not: the view key is random, so nothing can recompute it.
    for (const [name, path, optional, missingHint] of [
      ["Keystore", KEYSTORE_PATH, false, "none — run cowl init"],
      ["View key", VIEWKEY_PATH, false, "none — run cowl viewkey new"],
      ["Config", CONFIG_PATH, true, "not present, using defaults"],
    ] as const) {
      const mode = modeOf(path);
      checks.push({
        name,
        ok: mode === null ? optional : mode === 0o600,
        detail: mode === null ? missingHint : mode === 0o600 ? "0600, private" : `${mode.toString(8)}, should be 0600`,
      });
    }

    checks.push({
      name: "Wallet",
      ok: keystoreExists(),
      detail: keystoreExists() ? (keystoreAddress() ?? "unreadable") : "none — run cowl init",
    });

    if (json) {
      console.log(JSON.stringify({ checks }, null, 2));
      return;
    }

    heading("Doctor");
    for (const c of checks) {
      console.log(`  ${c.ok ? symbols.ok() : acid("!")} ${bone(c.name.padEnd(16))} ${muted(c.detail)}`);
    }
    const bad = checks.filter((c) => !c.ok);
    console.log(
      bad.length === 0
        ? `\n  ${muted("Everything looks right.")}`
        : `\n  ${muted(`${bad.length} thing${bad.length === 1 ? "" : "s"} to look at above.`)}`,
    );
    console.log(`  ${muted("Backed up lately?")} ${dim("cowl backup ~/cowl-backup.json")}`);
  });

// ---- network ----------------------------------------------------------------

const network = program.command("network").description("view or switch networks");

network
  .command("list", { isDefault: true })
  .description("list available networks")
  .action(() => {
    const cfg = loadConfig();
    heading("Networks");
    for (const n of Object.values(NETWORKS)) {
      const active = n.key === cfg.network;
      const mark = active ? symbols.dot() : muted("○");
      const rpc = n.rpcUrl ? muted(n.rpcUrl) : dim("(set an RPC)");
      console.log(`  ${mark} ${bold(active ? acid(n.key) : bone(n.key))}  ${muted(n.label)}`);
      console.log(`      ${rpc}`);
    }
  });

network
  .command("use")
  .description("switch the active network")
  .argument("<key>", "network key")
  .action((key: string) => {
    if (!NETWORKS[key]) die(`Unknown network "${key}".`, `Known: ${Object.keys(NETWORKS).join(", ")}`);
    const cfg = loadConfig();
    cfg.network = key;
    saveConfig(cfg);
    ok(`Active network: ${acid(key)}`);
  });

// ---- config -----------------------------------------------------------------

const config = program.command("config").description("read or write configuration");

config
  .command("path")
  .description("print the config file path")
  // Home is collapsed to ~ by default so screenshots and recordings do not leak
  // the account name. Scripts that need to open the file pass --absolute.
  .option("-a, --absolute", "print the full path, including your home directory")
  .action((opts: { absolute?: boolean }) => {
    console.log(opts.absolute ? CONFIG_PATH : displayPath(CONFIG_PATH));
  });

config
  .command("show", { isDefault: true })
  .description("show the resolved active network")
  .action(() => {
    const { net } = ctx();
    heading(`Config · ${net.label}`);
    row("network", acid(net.key));
    row("chainId", String(net.chainId || dim("unset")));
    row("rpcUrl", net.rpcUrl ? muted(net.rpcUrl) : dim("unset"));
    row("explorer", net.explorer ? muted(net.explorer) : dim("unset"));
    row("pool", net.contracts.pool ?? dim("not deployed"));
    row("relayer", net.contracts.relayer ?? dim("not deployed"));
    row("staking", net.contracts.staking ?? dim("not deployed"));
  });

config
  .command("set")
  .description("set a config value on the active network")
  .argument("<key>", "rpcUrl | chainId | explorer | contracts.pool | contracts.relayer | contracts.staking")
  .argument("<value>")
  .action((key: string, value: string) => {
    let cfg = loadConfig();
    try {
      cfg = setConfigValue(cfg, key, value);
    } catch (e) {
      die((e as Error).message);
    }
    saveConfig(cfg);
    ok(`Set ${acid(key)} = ${bone(value)} on ${muted(cfg.network)}`);
  });

// ---- balance ----------------------------------------------------------------

program
  .command("balance")
  .description("show your on-chain balance (or --shielded for your private balance)")
  .option("-t, --token <address>", "ERC-20 token address")
  .option("-s, --shielded", "show your shielded (private) balance")
  .action(async (opts: { token?: string; shielded?: boolean }) => {
    const { net, json } = ctx();

    if (opts.shielded) {
      const sym = net.currency.symbol;
      const keys = await shieldedKeys();
      const bal = poolBalance(net.key, keys);
      out(json, { shielded: bal.map((b) => ({ token: tokenLabel(b.token, sym), amount: formatEther(b.amount), notes: b.notes })) }, () => {
        heading("Shielded balance");
        if (bal.length === 0) {
          console.log(`  ${dim("Empty. Fund it with")} ${dim("cowl shield <amount>")}`);
        } else {
          for (const b of bal) row(tokenLabel(b.token, sym), `${bold(formatEther(b.amount))} ${muted(`· ${b.notes} note${b.notes === 1 ? "" : "s"}`)}`);
        }
        localNotice(net);
      });
      return;
    }

    const address = requireWallet();
    const s = json ? null : p.spinner();
    s?.start(`Reading ${net.label}`);
    try {
      if (opts.token) {
        if (!isAddress(opts.token)) die("Invalid token address.");
        const { amount, symbol } = await tokenBalance(net, opts.token as Address, address);
        s?.stop(`${net.label}`);
        out(json, { address, token: opts.token, amount, symbol }, () =>
          row(symbol, `${bold(amount)} ${muted(symbol)}`),
        );
      } else {
        const amount = await nativeBalance(net, address);
        s?.stop(`${net.label}`);
        out(json, { address, amount, symbol: net.currency.symbol }, () =>
          row(net.currency.symbol, `${bold(amount)} ${muted(net.currency.symbol)}`),
        );
      }
    } catch (e) {
      s?.stop("failed");
      die((e as Error).message);
    }
  });

// ---- address (stealth) ------------------------------------------------------

program
  .command("address")
  .description("generate a fresh stealth address to receive privately")
  .option("--meta", "show your stealth meta-address instead")
  .action(async (opts: { meta?: boolean }) => {
    requireWallet();
    const { json } = ctx();
    const pass = await askPassphrase();
    const pk = exportPrivateKey(pass);
    const meta = deriveMetaKeys(pk);

    if (opts.meta) {
      out(json, { metaAddress: meta.metaAddress }, () => {
        heading("Stealth meta-address");
        console.log(`  ${acid(meta.metaAddress)}`);
        console.log(`  ${muted("Share this so others can pay you at unlinkable one-time addresses.")}`);
      });
      return;
    }

    const s = generateStealthAddress(meta);
    out(json, s, () => {
      heading("One-time stealth address");
      row("Address", acid(s.stealthAddress));
      row("Ephemeral", muted(s.ephemeralPubKey));
      row("View tag", muted(s.viewTag));
      console.log(`  ${muted("Funds sent here are unlinkable to your main wallet on-chain.")}`);
    });
  });

// ---- viewkey ----------------------------------------------------------------

const vk = program.command("viewkey").description("selective-disclosure view keys");

vk
  .command("show", { isDefault: true })
  .description("show your public view key")
  .action(() => {
    const { json } = ctx();
    const key = readViewKey();
    if (!key) die("No view key.", "Create one: cowl viewkey new");
    out(json, key, () => {
      heading("View key");
      row("Public", acid(key.publicKey));
      row("Created", muted(key.createdAt));
      console.log(`  ${muted("Hand the public key to an auditor to grant read-only disclosure.")}`);
    });
  });

vk
  .command("new")
  .description("generate a new view key")
  .option("--force", "overwrite an existing view key")
  .action(async (opts: { force?: boolean }) => {
    if (viewKeyExists() && !opts.force) {
      const go = unwrap(await p.confirm({ message: "A view key exists. Replace it?", initialValue: false }));
      if (!go) return;
    }
    const key = createViewKey(new Date().toISOString());
    ok(`New view key: ${acid(key.publicKey)}`);
  });

// ---- fees -------------------------------------------------------------------

program
  .command("fees")
  .description("show the protocol fee schedule")
  .action(() => {
    const { json } = ctx();
    out(json, { fees: FEES, split: FEE_SPLIT }, () => {
      heading("Fees");
      for (const f of FEES) {
        console.log(`  ${bold(bone(f.name.padEnd(14)))} ${acid(f.rate)}`);
        console.log(`      ${muted(`${f.when} → ${f.to}`)}`);
      }
      heading("Where protocol fees go");
      for (const s of FEE_SPLIT) row(s.to, acid(s.share));
      console.log(`\n  ${dim("Indicative only — set by governance at launch.")}`);
    });
  });

// ---- ping -------------------------------------------------------------------

program
  .command("ping")
  .description("check RPC connectivity")
  .action(async () => {
    const { net, json } = ctx();
    const s = json ? null : p.spinner();
    s?.start(`Pinging ${net.label}`);
    const started = process.hrtime.bigint();
    try {
      const client = publicClient(net);
      const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      s?.stop(`${net.label}`);
      out(json, { chainId, block: block.toString(), latencyMs: Math.round(ms) }, () => {
        row("chainId", bone(String(chainId)));
        row("block", bone(block.toString()));
        row("latency", `${bone(String(Math.round(ms)))} ${muted("ms")}`);
      });
    } catch (e) {
      s?.stop("unreachable");
      die((e as Error).message);
    }
  });

// ---- status (offline overview) ----------------------------------------------

/** A fast, offline snapshot of your setup — no RPC calls. */
function runStatus(showSplash = false): void {
  const { net, json } = ctx();
  const addr = keystoreAddress();
  const vkey = readViewKey();
  const c = net.contracts;

  if (json) {
    console.log(
      JSON.stringify(
        {
          wallet: addr,
          viewKey: vkey ? { publicKey: vkey.publicKey, createdAt: vkey.createdAt } : null,
          network: { key: net.key, label: net.label, chainId: net.chainId, rpcUrl: net.rpcUrl, explorer: net.explorer, testnet: net.testnet },
          contracts: { pool: c.pool ?? null, relayer: c.relayer ?? null, staking: c.staking ?? null },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (showSplash) console.log(splash());
  heading(`Status · ${net.label}`);
  row("Wallet", addr ? acid(addr) : dim("not set up → cowl init"));
  row("View key", vkey ? `${symbols.ok()} ${muted(`created ${vkey.createdAt.slice(0, 10)}`)}` : dim("none → cowl viewkey new"));
  row("Network", `${bone(net.key)} ${muted(`· chainId ${net.chainId}`)}`);
  row("RPC", net.rpcUrl ? muted(net.rpcUrl) : dim("unset → cowl config set rpcUrl <url>"));

  heading("Shielded protocol");
  const contract = (v?: string) => (v ? acid(v) : dim("not deployed yet"));
  row("pool", contract(c.pool));
  row("relayer", contract(c.relayer));
  row("staking", contract(c.staking));

  if (!addr) {
    console.log(`\n  ${muted("Start here:")} ${dim("cowl init")}`);
  } else {
    console.log(
      `\n  ${muted("Next:")} ${dim("cowl balance")} ${muted("·")} ${dim("cowl address")} ${muted("·")} ${dim("cowl faucet")} ${muted("·")} ${dim("cowl ping")}`,
    );
  }
}

program
  .command("status")
  .description("show a quick overview of your wallet, network, and protocol status")
  // Wrapped: passing runStatus directly would receive Commander's options object
  // as its first argument and read as a truthy showSplash.
  .action(() => runStatus());

// ---- faucet -----------------------------------------------------------------

program
  .command("faucet")
  .description("where to get testnet funds for the active network")
  .action(() => {
    const { net, json } = ctx();
    const list = FAUCETS[net.key] ?? [];
    const addr = keystoreAddress();

    if (json) {
      console.log(JSON.stringify({ network: net.key, address: addr, faucets: list }, null, 2));
      return;
    }

    if (!net.testnet) {
      warn(`${bone(net.label)} is not a testnet — there is no faucet.`);
      console.log(`  ${muted("Switch to a testnet:")} ${dim("cowl network use robinhood-testnet")}`);
      return;
    }

    heading(`Faucets · ${net.label}`);
    if (list.length === 0) {
      console.log(`  ${dim("No faucets on file for this network.")}`);
    } else {
      for (const f of list) {
        console.log(`  ${symbols.dot()} ${bold(bone(f.name))}`);
        console.log(`      ${muted(f.url)}`);
        if (f.note) console.log(`      ${dim(f.note)}`);
      }
    }

    if (addr) {
      console.log(`\n  ${muted("Paste this address into the faucet:")}`);
      console.log(`  ${acid(addr)}`);
    } else {
      console.log(`\n  ${muted("Create a wallet first:")} ${dim("cowl init")}`);
    }
  });

// ---- logo -------------------------------------------------------------------

program
  .command("logo")
  .description("print the Cowl logo")
  .action(() => {
    console.log(logo());
  });

// ---- send (real transfer) ---------------------------------------------------

program
  .command("send")
  .description("send funds — publicly to an 0x address, or privately to a zcowl: address")
  .argument("<amount>", "amount, e.g. 0.01")
  .argument("<token>", "native symbol (e.g. ETH) or an ERC-20 address")
  .argument("<to>", "recipient: 0x address (public) or zcowl: address (private)")
  .action(async (amount: string, token: string, to: string) => {
    const { net } = ctx();
    if (!(Number(amount) > 0)) die("Amount must be positive.");

    // A zcowl: recipient is a private, in-pool transfer from your shielded balance.
    if (isPaymentAddress(to)) {
      const sym = net.currency.symbol;
      const tokenField = tokenToField(token, sym);
      const recipient = decodePaymentAddress(to);
      const keys = await shieldedKeys();
      try {
        const res = sendPrivate(net.key, keys, recipient, parseEther(amount), tokenField);
        heading("Private send");
        row("To", bone(to.slice(0, 22) + "…"));
        row("Amount", `${bold(amount)} ${muted(tokenLabel(tokenField, sym))}`);
        row("Nullifiers", muted(res.nullifiers.length === 1 ? res.nullifiers[0]! : `${res.nullifiers.length} notes spent`));
        if (res.outCommitment) row("Output note", muted(res.outCommitment));
        if (res.changeCommitment) row("Change note", muted(res.changeCommitment));
        localNotice(net);
      } catch (e) {
        die((e as Error).message);
      }
      return;
    }

    const address = requireWallet();
    if (!isAddress(to)) die("Invalid recipient address.", "Use a 0x address (public) or a zcowl: address (private).");

    const isNative = token.toUpperCase() === net.currency.symbol.toUpperCase();
    if (!isNative && !isAddress(token)) die(`Unknown token "${token}".`, `Use ${net.currency.symbol} or an ERC-20 address.`);

    heading("Send");
    row("From", muted(address));
    row("To", bone(to));
    row("Amount", `${bold(amount)} ${muted(isNative ? net.currency.symbol : "tokens")}`);
    row("Network", muted(net.label));

    const go = unwrap(await p.confirm({ message: "Sign and broadcast?", initialValue: false }));
    if (!go) return;

    const pass = await askPassphrase();
    const { unlockKeystore } = await import("./keystore.js");
    const account = unlockKeystore(pass);

    const s = p.spinner();
    s.start("Broadcasting");
    try {
      const hash = isNative
        ? await sendNative(net, account, to as Address, amount)
        : await sendToken(net, account, token as Address, to as Address, amount);
      s.message("Waiting for confirmation");
      await waitForReceipt(net, hash);
      s.stop("Confirmed");
      ok(`Sent. ${muted(txLink(net, hash))}`);
    } catch (e) {
      s.stop("failed");
      die((e as Error).message);
    }
  });

// ---- shielded pool ----------------------------------------------------------

program
  .command("shield")
  .description("move funds into your shielded (private) balance")
  .argument("<amount>", "amount, e.g. 0.1")
  .argument("[token]", "native symbol (default) or an ERC-20 address")
  .action(async (amount: string, token?: string) => {
    const { net } = ctx();
    const sym = net.currency.symbol;
    if (!(Number(amount) > 0)) die("Amount must be positive.");
    const tokenField = tokenToField(token ?? sym, sym);
    const keys = await shieldedKeys();
    const res = poolShield(net.key, keys, parseEther(amount), tokenField);
    heading("Shielded");
    row("Amount", `${bold(amount)} ${muted(tokenLabel(tokenField, sym))}`);
    row("Commitment", muted(res.commitment));
    row("Leaf", muted(`#${res.leafIndex}`));
    row("Root", muted(res.root));
    localNotice(net);
  });

program
  .command("unshield")
  .description("move funds out of your shielded balance")
  .argument("<amount>", "amount, e.g. 0.1")
  .argument("[token]", "native symbol (default) or an ERC-20 address")
  .action(async (amount: string, token?: string) => {
    const { net } = ctx();
    const sym = net.currency.symbol;
    if (!(Number(amount) > 0)) die("Amount must be positive.");
    const tokenField = tokenToField(token ?? sym, sym);
    const keys = await shieldedKeys();
    try {
      const res = poolUnshield(net.key, keys, parseEther(amount), tokenField);
      heading("Unshielded");
      row("Amount", `${bold(amount)} ${muted(tokenLabel(tokenField, sym))}`);
      row("Nullifiers", muted(res.nullifiers.length === 1 ? res.nullifiers[0]! : `${res.nullifiers.length} notes spent`));
      if (res.changeCommitment) row("Change note", muted(res.changeCommitment));
      localNotice(net);
    } catch (e) {
      die((e as Error).message);
    }
  });

program
  .command("receive")
  .description("show your shielded payment address (share it to be paid privately)")
  .action(async () => {
    const { json } = ctx();
    const keys = await shieldedKeys();
    out(json, { paymentAddress: keys.paymentAddress }, () => {
      heading("Shielded payment address");
      console.log(`  ${acid(keys.paymentAddress)}`);
      console.log(`  ${muted("Share this. Payments to it land in your shielded balance, unlinkable on-chain.")}`);
    });
  });

program
  .command("scan")
  .description("scan the shielded pool for notes paid to you")
  .action(async () => {
    const { net, json } = ctx();
    const keys = await shieldedKeys();
    const { discovered } = poolScan(net.key, keys);
    out(json, { discovered }, () =>
      ok(discovered > 0 ? `Found ${bold(String(discovered))} new note${discovered === 1 ? "" : "s"}.` : "No new notes."),
    );
  });

/** Format a WAD-scaled amount to a fixed number of decimals. */
function fmt(x: bigint, decimals = 2): string {
  return Number(formatEther(x)).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Trim a WAD amount to at most 6 decimals, without trailing zeros. */
function fmtAmount(x: bigint): string {
  const s = formatEther(x);
  if (!s.includes(".")) return s;
  const [whole, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

/** Scale a raw token amount to 18 decimals so everything values consistently. */
function toWad(raw: bigint, decimals: number): bigint {
  if (decimals === 18) return raw;
  return decimals < 18 ? raw * 10n ** BigInt(18 - decimals) : raw / 10n ** BigInt(decimals - 18);
}

type PortfolioRow = { symbol: string; amount: bigint; value: bigint | null; notes?: number };

const COLS = { asset: 8, amount: 16, value: 15, share: 7 };

function valueOf(symbol: string, amountWad: bigint): bigint | null {
  const price = priceInQuoteWad(symbol);
  return price === null ? null : (amountWad * price) / WAD;
}

function sortByValue(rows: PortfolioRow[]): PortfolioRow[] {
  return [...rows].sort((a, b) => ((b.value ?? 0n) > (a.value ?? 0n) ? 1 : (b.value ?? 0n) < (a.value ?? 0n) ? -1 : 0));
}

/** Print one portfolio section and return its total value. */
function renderSection(title: string, note: string, rows: PortfolioRow[], emptyHint: string): bigint {
  const sorted = sortByValue(rows);
  const total = sorted.reduce((s, r) => s + (r.value ?? 0n), 0n);

  heading(title);
  console.log(`  ${dim(note)}`);
  if (sorted.length === 0) {
    console.log(`  ${dim(emptyHint)}`);
    return 0n;
  }

  console.log(
    `  ${muted("ASSET".padEnd(COLS.asset))} ${muted("AMOUNT".padStart(COLS.amount))} ${muted(
      `VALUE (${QUOTE_SYMBOL})`.padStart(COLS.value),
    )} ${muted("SHARE".padStart(COLS.share))}`,
  );
  for (const r of sorted) {
    const share = total > 0n && r.value !== null ? `${(Number((r.value * 10000n) / total) / 100).toFixed(1)}%` : "—";
    console.log(
      `  ${bone(r.symbol.padEnd(COLS.asset))} ${bold(fmtAmount(r.amount).padStart(COLS.amount))} ${acid(
        (r.value === null ? "—" : fmt(r.value)).padStart(COLS.value),
      )} ${muted(share.padStart(COLS.share))}`,
    );
  }
  console.log(`  ${muted("─".repeat(COLS.asset + COLS.amount + COLS.value + COLS.share + 3))}`);
  const notes = sorted.reduce((s, r) => s + (r.notes ?? 0), 0);
  console.log(
    `  ${bold(bone("Subtotal".padEnd(COLS.asset)))} ${"".padStart(COLS.amount)} ${bold(acid(fmt(total).padStart(COLS.value)))}   ${muted(
      notes > 0 ? `${sorted.length} pos · ${notes} note${notes === 1 ? "" : "s"}` : `${sorted.length} pos`,
    )}`,
  );
  return total;
}

program
  .command("portfolio")
  .description("show your full portfolio: public on-chain holdings and your shielded balance")
  .option("-p, --public", "public on-chain holdings only")
  .option("-s, --shielded", "shielded holdings only")
  .action(async (opts: { public?: boolean; shielded?: boolean }) => {
    const { net, json } = ctx();
    const sym = net.currency.symbol;
    const showPublic = !(opts.shielded && !opts.public);
    const showShielded = !(opts.public && !opts.shielded);

    const address = requireWallet();
    const keys = showShielded ? await shieldedKeys() : null;

    // ---- public (on-chain) ----
    let publicRows: PortfolioRow[] = [];
    if (showPublic) {
      const s = json ? null : p.spinner();
      s?.start(`Reading ${net.label}`);
      try {
        const tokens = trackedTokens(loadConfig());
        const [wei, tokenReads] = await Promise.all([
          publicClient(net).getBalance({ address }),
          Promise.all(
            tokens.map((t) =>
              tokenInfo(net, t as Address, address).then(
                (r) => ({ ...r, address: t }),
                () => null,
              ),
            ),
          ),
        ]);
        s?.stop(net.label);
        publicRows = [{ symbol: sym, amount: wei, value: valueOf(sym, wei) }];
        for (const t of tokenReads) {
          if (!t || t.raw === 0n) continue;
          const amount = toWad(t.raw, t.decimals);
          publicRows.push({ symbol: t.symbol, amount, value: valueOf(t.symbol, amount) });
        }
      } catch (e) {
        s?.stop("failed");
        die((e as Error).message);
      }
    }

    // ---- shielded (local notes) ----
    let shieldedRows: PortfolioRow[] = [];
    if (showShielded && keys) {
      shieldedRows = poolBalance(net.key, keys).map((b) => {
        const symbol = tokenLabel(b.token, sym);
        return { symbol, amount: b.amount, value: valueOf(symbol, b.amount), notes: b.notes };
      });
    }

    if (json) {
      const pack = (rows: PortfolioRow[]) =>
        sortByValue(rows).map((r) => ({
          symbol: r.symbol,
          amount: formatEther(r.amount),
          value: r.value === null ? null : formatEther(r.value),
          ...(r.notes === undefined ? {} : { notes: r.notes }),
        }));
      const pubTotal = publicRows.reduce((s, r) => s + (r.value ?? 0n), 0n);
      const shTotal = shieldedRows.reduce((s, r) => s + (r.value ?? 0n), 0n);
      console.log(
        JSON.stringify(
          {
            quote: QUOTE_SYMBOL,
            poolDeployed: !!net.contracts.pool,
            public: showPublic ? { total: formatEther(pubTotal), positions: pack(publicRows) } : undefined,
            shielded: showShielded
              ? { total: formatEther(shTotal), simulated: !net.contracts.pool, positions: pack(shieldedRows) }
              : undefined,
            // Only one book once the pool exists; before that, summing double counts.
            total: net.contracts.pool ? formatEther(pubTotal + shTotal) : null,
          },
          null,
          2,
        ),
      );
      return;
    }

    let pubTotal = 0n;
    let shTotal = 0n;
    if (showPublic) {
      pubTotal = renderSection(
        `Public · ${net.label}`,
        "visible to anyone on the explorer",
        publicRows,
        `Nothing here. Track tokens with ${"cowl token add <address>"}`,
      );
    }
    if (showShielded) {
      shTotal = renderSection(
        "Shielded",
        "private, computed from your notes",
        shieldedRows,
        "Empty. Fund it with cowl shield <amount> [token]",
      );
    }

    if (showPublic && showShielded) {
      heading("Total");
      if (net.contracts.pool) {
        // Shielding moved real funds, so the two sides are one book.
        const total = pubTotal + shTotal;
        const pct = total > 0n ? Number((shTotal * 10000n) / total) / 100 : 0;
        row("Portfolio", `${bold(acid(fmt(total)))} ${muted(QUOTE_SYMBOL)}`);
        row("Shielded", `${bold(`${pct.toFixed(1)}%`)} ${muted("of your book is off the explorer")}`);
      } else {
        // No pool contract: shielding never left the machine, so the public side
        // still holds the same coins. Adding these would count them twice.
        row("Public", `${bold(acid(fmt(pubTotal)))} ${muted(QUOTE_SYMBOL)}`);
        row("Shielded", `${bold(acid(fmt(shTotal)))} ${muted(`${QUOTE_SYMBOL} · simulated`)}`);
        console.log(
          `\n  ${warnMark()} ${muted(
            "Not one book yet. Shielding is local until the pool deploys, so nothing was deducted from your public holdings and these two cannot be summed.",
          )}`,
        );
      }
    }
    if (showShielded) localNotice(net);
  });

// ---- tracked tokens ---------------------------------------------------------

const token = program.command("token").description("ERC-20 tokens tracked in your portfolio");

token
  .command("list", { isDefault: true })
  .description("list tracked tokens")
  .action(async () => {
    const { net, json } = ctx();
    const tokens = trackedTokens(loadConfig());

    if (tokens.length === 0) {
      out(json, { network: net.key, tokens: [] }, () => {
        heading(`Tracked tokens · ${net.label}`);
        console.log(`  ${dim("None. Add one:")} ${dim("cowl token add 0x…")}`);
      });
      return;
    }

    // Resolve symbols on chain so the list is readable; fall back to the address.
    const s = json ? null : p.spinner();
    s?.start("Reading tokens");
    const rows = await Promise.all(
      tokens.map((address) =>
        tokenMeta(net, address as Address).then(
          (m) => ({ address, symbol: m.symbol as string | null, decimals: m.decimals as number | null }),
          () => ({ address, symbol: null, decimals: null }),
        ),
      ),
    );
    s?.stop(net.label);

    out(json, { network: net.key, tokens: rows }, () => {
      heading(`Tracked tokens · ${net.label}`);
      for (const r of rows) {
        const label = r.symbol ?? "unreadable";
        console.log(`  ${symbols.dot()} ${bold(bone(label.padEnd(8)))} ${muted(r.address)}`);
      }
    });
  });

token
  .command("add")
  .description("track an ERC-20 token in your portfolio")
  .argument("<address>", "ERC-20 contract address")
  .action(async (address: string) => {
    const { net } = ctx();
    if (!isAddress(address)) die("Invalid token address.");
    const s = p.spinner();
    s.start("Reading token");
    try {
      const info = await tokenMeta(net, address as Address);
      s.stop(info.symbol);
      saveConfig(addTrackedToken(loadConfig(), address));
      ok(`Tracking ${acid(info.symbol)} ${muted(address)}`);
    } catch (e) {
      s.stop("failed");
      die(`Could not read that token on ${net.label}.`, (e as Error).message);
    }
  });

token
  .command("remove")
  .description("stop tracking a token")
  .argument("<address>", "ERC-20 contract address")
  .action((address: string) => {
    saveConfig(removeTrackedToken(loadConfig(), address));
    ok(`Removed ${muted(address)}`);
  });

program
  .command("markets")
  .description("list private-trade markets and indicative prices")
  .action(() => {
    const { json } = ctx();
    const list = Object.values(MARKETS).map((m) => ({ market: m.key, base: m.base, quote: m.quote, price: formatEther(m.priceWad) }));
    out(json, { markets: list, feeBps: Number(PROTOCOL_FEE_BPS) }, () => {
      heading("Markets");
      for (const m of list) row(m.market, `${bold(m.price)} ${muted(m.quote)}`);
      console.log(`\n  ${muted(`Protocol fee ~${(Number(PROTOCOL_FEE_BPS) / 100).toFixed(2)}% · indicative prices, local sim.`)}`);
    });
  });

program
  .command("trade")
  .description("private trade: swap one shielded token for another")
  .argument("<side>", "buy | sell")
  .argument("<amount>", "amount you spend (base for sell, quote for buy)")
  .argument("<market>", "market, e.g. TSLA-USDG")
  .action(async (side: string, amount: string, market: string) => {
    const { net } = ctx();
    const sym = net.currency.symbol;
    const sideNorm = side.toLowerCase();
    if (sideNorm !== "buy" && sideNorm !== "sell") die('Side must be "buy" or "sell".');
    const mkey = market.toUpperCase();
    if (!MARKETS[mkey]) die(`Unknown market "${market}".`, `Known: ${Object.keys(MARKETS).join(", ")}`);
    if (!(Number(amount) > 0)) die("Amount must be positive.");

    const q = quoteTrade(mkey, sideNorm as Side, parseEther(amount));
    const inField = tokenToField(q.inputSymbol, sym);
    const outField = tokenToField(q.outputSymbol, sym);
    const keys = await shieldedKeys();
    try {
      const res = poolTrade(net.key, keys, inField, outField, q.amountIn, q.amountOut);
      heading("Private trade");
      row("Market", bone(mkey));
      row("Side", sideNorm === "buy" ? acid("buy") : acid("sell"));
      row("Spent", `${bold(formatEther(q.amountIn))} ${muted(q.inputSymbol)}`);
      row("Received", `${bold(formatEther(q.amountOut))} ${muted(q.outputSymbol)}`);
      row("Price", muted(`${formatEther(q.priceWad)} ${MARKETS[mkey]!.quote} / ${MARKETS[mkey]!.base}`));
      row("Fee", muted(`${formatEther(q.feeAmount)} ${q.feeToken}`));
      row("Output note", muted(res.outputCommitment));
      if (res.changeCommitment) row("Change note", muted(res.changeCommitment));
      localNotice(net);
    } catch (e) {
      die((e as Error).message);
    }
  });

program
  .command("stake")
  .description("stake $COWL to back the network")
  .argument("<amount>")
  .action(() => pending("Staking", "staking", ctx().net));

// ---- default: bare `cowl` shows status --------------------------------------

/** Levenshtein distance, used to suggest the command someone meant to type. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
}

function closestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const name of program.commands.map((c) => c.name())) {
    const d = editDistance(input.toLowerCase(), name.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  // Only suggest a genuine typo: one edit away, or two when it starts the same.
  if (!best) return null;
  const sameStart = best[0]?.toLowerCase() === input[0]?.toLowerCase();
  return bestDistance <= 1 || (bestDistance === 2 && sameStart) ? best : null;
}

// Commander routes anything it does not recognise here, so an unknown command
// must be rejected rather than quietly falling through to the status overview.
program.action(() => {
  const [unknown] = program.args;
  if (unknown) {
    const guess = closestCommand(unknown);
    die(
      `Unknown command "${unknown}".`,
      guess ? `Did you mean "cowl ${guess}"? Run cowl --help for everything.` : "Run cowl --help to see every command.",
    );
  }
  runStatus(true);
});

// ---- run --------------------------------------------------------------------

program.parseAsync().catch((e) => {
  die((e as Error).message);
});
