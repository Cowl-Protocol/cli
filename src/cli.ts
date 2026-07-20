import { Command } from "commander";
import * as p from "@clack/prompts";
import { isAddress, type Address } from "viem";
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
import { COWL_DIR, CONFIG_PATH } from "./paths.js";
import { loadConfig, saveConfig, activeNetwork, setConfigValue, type Config } from "./config.js";
import { NETWORKS, type NetworkDef, type CowlContracts } from "./networks.js";
import {
  keystoreExists,
  keystoreAddress,
  createKeystore,
  importKeystore,
  exportPrivateKey,
} from "./keystore.js";
import {
  nativeBalance,
  tokenBalance,
  sendNative,
  sendToken,
  waitForReceipt,
  publicClient,
} from "./chain.js";
import { deriveMetaKeys, generateStealthAddress } from "./stealth.js";
import { createViewKey, readViewKey, viewKeyExists } from "./viewkey.js";
import { FEES, FEE_SPLIT } from "./fees.js";

const VERSION = "0.1.1";

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
  return p.password({ message }).then(unwrap);
}

function txLink(net: NetworkDef, hash: string): string {
  return net.explorer ? `${net.explorer}/tx/${hash}` : hash;
}

function out(json: boolean, obj: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else human();
}

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
    console.log(banner());
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
        { value: "new", label: "Create a new wallet" },
        { value: "import", label: "Import an existing private key" },
      ],
    });
    const mode = unwrap(modeSel);

    let pk: string | undefined;
    if (mode === "import") {
      pk = unwrap(await p.text({ message: "Private key (0x…)", validate: (v) => (/^0x?[0-9a-fA-F]{64}$/.test(v.trim()) ? undefined : "Need a 32-byte hex key.") }));
    }

    const pass = await askPassphrase("Choose a passphrase (encrypts your key)");
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

    const address = mode === "import" ? importKeystore(pk!, pass) : createKeystore(pass);

    const cfg = loadConfig();
    cfg.network = netKey;
    saveConfig(cfg);

    if (!viewKeyExists()) createViewKey(new Date().toISOString());

    p.outro(`${symbols.ok()} ${bold("Ready.")}`);
    row("Address", acid(address));
    row("Network", bone(NETWORKS[netKey]!.label));
    row("Stored in", muted(COWL_DIR));
    console.log(`\n  ${muted("Next:")} ${dim("cowl balance")} ${muted("·")} ${dim("cowl address")} ${muted("·")} ${dim("cowl fees")}`);
  });

// ---- wallet -----------------------------------------------------------------

const wallet = program.command("wallet").description("manage your local wallet");

wallet
  .command("new")
  .description("create a new wallet")
  .option("--force", "overwrite an existing wallet")
  .action(async (opts: { force?: boolean }) => {
    if (keystoreExists() && !opts.force) die("A wallet already exists.", "Overwrite: cowl wallet new --force");
    const pass = await askPassphrase("Choose a passphrase");
    const pass2 = await askPassphrase("Confirm passphrase");
    if (pass !== pass2) die("Passphrases do not match.");
    const address = createKeystore(pass);
    ok(`New wallet: ${acid(address)}`);
  });

wallet
  .command("import")
  .description("import a private key")
  .argument("[privateKey]", "0x-prefixed private key (prompted if omitted)")
  .option("--force", "overwrite an existing wallet")
  .action(async (pkArg: string | undefined, opts: { force?: boolean }) => {
    if (keystoreExists() && !opts.force) die("A wallet already exists.", "Overwrite: cowl wallet import --force");
    const pk = pkArg ?? (unwrap(await p.text({ message: "Private key (0x…)" })));
    const pass = await askPassphrase("Choose a passphrase");
    const address = importKeystore(pk, pass);
    ok(`Imported: ${acid(address)}`);
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
  .description("reveal your private key (dangerous)")
  .action(async () => {
    requireWallet();
    warn("This prints your private key in plaintext.");
    const go = unwrap(await p.confirm({ message: "Continue?", initialValue: false }));
    if (!go) return;
    const pass = await askPassphrase();
    const pk = exportPrivateKey(pass);
    console.log(`\n  ${bold(pk)}\n`);
    warn("Anyone with this key controls your funds. Never share it.");
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
  .action(() => console.log(CONFIG_PATH));

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
  .description("show your on-chain balance")
  .option("-t, --token <address>", "ERC-20 token address")
  .action(async (opts: { token?: string }) => {
    const address = requireWallet();
    const { net, json } = ctx();
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

// ---- send (real transfer) ---------------------------------------------------

program
  .command("send")
  .description("send funds to an address (native coin or ERC-20)")
  .argument("<amount>", "amount, e.g. 0.01")
  .argument("<token>", "native symbol (e.g. ETH) or an ERC-20 address")
  .argument("<to>", "recipient address (a stealth address works)")
  .action(async (amount: string, token: string, to: string) => {
    const address = requireWallet();
    const { net } = ctx();
    if (!isAddress(to)) die("Invalid recipient address.");
    if (!(Number(amount) > 0)) die("Amount must be positive.");

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

// ---- protocol ops (testnet-first, gated on deployed contracts) --------------

program
  .command("shield")
  .description("deposit into the shielded pool")
  .argument("<amount>")
  .argument("[token]")
  .action(() => pending("Shielding", "pool", ctx().net));

program
  .command("unshield")
  .description("withdraw from the shielded pool")
  .argument("<amount>")
  .argument("[token]")
  .action(() => pending("Unshielding", "pool", ctx().net));

program
  .command("trade")
  .description("execute a private trade")
  .argument("<side>", "buy | sell")
  .argument("<amount>")
  .argument("<market>")
  .action(() => pending("Private trading", "pool", ctx().net));

program
  .command("stake")
  .description("stake $COWL to back the network")
  .argument("<amount>")
  .action(() => pending("Staking", "staking", ctx().net));

// ---- run --------------------------------------------------------------------

program.parseAsync().catch((e) => {
  die((e as Error).message);
});
