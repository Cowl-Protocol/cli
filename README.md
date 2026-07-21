<div align="center">

# @cowlprotocol/cli

**Private trading on Robinhood Chain — from your terminal.**

[![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-Arbitrum_L2-d7fb08?style=flat-square&labelColor=0a0b0e)](https://cowlprotocol.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white&labelColor=0a0b0e)](https://www.typescriptlang.org)
[![Solidity](https://img.shields.io/badge/Solidity-^0.8-6f7bf7?style=flat-square&logo=solidity&logoColor=white&labelColor=0a0b0e)](https://soliditylang.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-3c873a?style=flat-square&logo=node.js&logoColor=white&labelColor=0a0b0e)](https://nodejs.org)
[![viem](https://img.shields.io/badge/viem-2.x-1a1a1a?style=flat-square&labelColor=0a0b0e)](https://viem.sh)
[![ZK](https://img.shields.io/badge/ZK-shielded_pool-d7fb08?style=flat-square&labelColor=0a0b0e)](https://cowlprotocol.com/docs/shielded-pool)
[![npm](https://img.shields.io/npm/v/@cowlprotocol/cli?style=flat-square&color=d7fb08&labelColor=0a0b0e)](https://www.npmjs.com/package/@cowlprotocol/cli)
[![License](https://img.shields.io/badge/License-MIT-8c9196?style=flat-square&labelColor=0a0b0e)](./LICENSE)

</div>

Terminal CLI for [Cowl Protocol](https://cowlprotocol.com) — private trading on Robinhood Chain.
Manage a local wallet, generate one-time **stealth addresses**, hold **view keys** for selective
disclosure, read balances, send funds, and check the **fee** schedule — all from your terminal.
Testnet-first: everything that can be real today is real; on-chain shielded-pool operations light
up as the protocol contracts deploy.

## How it works

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#111419','primaryTextColor':'#ece8dc','primaryBorderColor':'#d7fb08','lineColor':'#8c9196','clusterBkg':'#0a1a1f','clusterBorder':'#1c4a55','fontFamily':'monospace'}}}%%
flowchart LR
  U["you · terminal"] -->|cowl …| CLI

  subgraph CLI["cowl CLI · your machine"]
    direction TB
    K["keystore<br/>scrypt + AES-256-GCM"]
    S["stealth<br/>ERC-5564 · secp256k1"]
    V["view key<br/>ed25519"]
    R["viem client"]
  end

  CLI -->|JSON-RPC| CHAIN

  subgraph CHAIN["Robinhood Chain · Arbitrum L2"]
    direction TB
    P["Shielded Pool"]
    RL["Gasless Relayer"]
    ST["$COWL Staking"]
  end
```

Keys never leave your machine. The CLI signs locally and talks to the chain over JSON-RPC.

## Private trading & fees

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#111419','primaryTextColor':'#ece8dc','primaryBorderColor':'#d7fb08','lineColor':'#8c9196','clusterBkg':'#1a1012','clusterBorder':'#4a2124','fontFamily':'monospace'}}}%%
flowchart LR
  W["your wallet"] -->|shield| POOL["Shielded Pool"]
  POOL -->|private trade| POOL
  POOL -->|unshield| OUT["stealth address"]
  POOL -->|protocol fee| FC["Fee Collector"]
  FC -->|50%| STK["stakers"]
  FC -->|30%| BURN["buyback & burn"]
  FC -->|20%| TRE["treasury"]
```

Your book stays off the public explorer; fees flow back to stakers, the burn, and the treasury.
See [fee structure](https://cowlprotocol.com/docs/fee-structure) ·
[fee collector](https://cowlprotocol.com/docs/fee-collector).

## Install

```bash
npm install -g @cowlprotocol/cli
```

Requires **Node.js 18+**. The command is `cowl`.

---

## Quick start

```bash
cowl init                 # create a wallet + view key, pick a network
cowl                      # quick status overview (offline)
cowl faucet               # where to get testnet funds
cowl balance              # read your on-chain balance
cowl address              # fresh stealth address to receive privately
cowl fees                 # protocol fee schedule
cowl ping                 # RPC connectivity check
```

Everything lives in `~/.cowl/` (private, mode `0600`). Nothing leaves your machine unless you
broadcast a transaction.

---

## Wallet

A local, encrypted EVM keystore. Your key is sealed with a passphrase (scrypt + AES-256-GCM) and
never stored in plaintext.

```bash
cowl init                       # guided setup (new or import + passphrase + network)
cowl wallet new                 # create a new wallet
cowl wallet import [0x…]        # import a private key
cowl wallet address             # print your address
cowl wallet export              # reveal your private key (asks to confirm)
```

---

## Stealth addresses

ERC-5564-style stealth addresses over secp256k1. Each one is a fresh, unlinkable destination that
only you can spend from. Spending and viewing keys are derived from your wallet, so addresses are
always recoverable from one seed.

```bash
cowl address                    # generate a one-time stealth address
cowl address --meta             # show your shareable stealth meta-address
```

---

## View keys

An ed25519 keypair for **selective disclosure**. Hand the public half to an auditor or tax
authority to grant read-only insight — and nothing more. The private half never leaves `~/.cowl`.

```bash
cowl viewkey show               # print your public view key
cowl viewkey new                # generate a new view key
```

---

## Balances & transfers

```bash
cowl balance                            # native balance
cowl balance --token 0x…                # ERC-20 balance

cowl send <amount> <token> <to>         # send funds (a stealth address works)
cowl send 0.01 ETH 0xRecipient…         # native transfer
cowl send 100 0xToken… 0xRecipient…     # ERC-20 transfer
```

---

## Networks & config

Robinhood Chain is an Arbitrum-based L2. Its public testnet (chainId `46630`, live since Feb 2026)
is the default, so reads, transfers, and connectivity are real today; mainnet (chainId `4663`) and
Arbitrum Sepolia are also built in. The official Robinhood RPC is geo-restricted in some regions,
so the default points at a globally-reachable endpoint — swap it any time. Everything is overridable.

```bash
cowl network                    # list networks (active is marked)
cowl network use <key>          # switch active network

cowl config show                # resolved network + contract addresses
cowl config set rpcUrl <url>    # override the RPC
cowl config set contracts.pool 0x…      # set a contract address once deployed
```

## Status & faucet

```bash
cowl                            # or `cowl status` — offline overview of wallet, network, contracts
cowl faucet                     # testnet faucet links for the active network + your address
```

Global flags: `--network <key>`, `--rpc <url>`, and `--json` (machine-readable output) work on
any command.

---

## Fees

```bash
cowl fees                       # protocol fee schedule + where fees go
```

See the docs for detail: [fee structure](https://cowlprotocol.com/docs/fee-structure) ·
[fee collector](https://cowlprotocol.com/docs/fee-collector).

---

## Portfolio

One view of everything you hold: what the explorer can see, and what it cannot.

```bash
cowl portfolio                  # public on-chain holdings + your shielded balance
cowl portfolio --public         # on-chain only
cowl portfolio --shielded       # shielded only

cowl token add 0x…              # track an ERC-20 (reads its symbol and decimals on-chain)
cowl token list                 # tracked tokens
cowl token remove 0x…
```

Positions are valued in USDG and the summary reports how much of your book sits off the explorer.
Native balance is always included; ERC-20s show up once you track them.

## Shielded pool

Your **private balance**. Funds you shield become **notes** — hidden UTXOs whose commitments live
in a Poseidon Merkle tree; spending one reveals only a **nullifier**, never the note. Balances are
computed locally by scanning for notes encrypted to your view key, so your book never touches the
public explorer.

```bash
cowl shield 0.1 ETH             # move funds into your shielded balance
cowl balance --shielded         # your private portfolio, grouped by token
cowl receive                    # your zcowl: payment address — share it to be paid privately
cowl send 0.05 ETH zcowl:0x…    # private, in-pool transfer to a zcowl: address
cowl scan                       # find notes paid to you
cowl unshield 0.05 ETH          # move funds back out
```

### Private trades

A shielded swap spends a note of one token and mints a note of another, so your size and direction
never hit the public explorer. `amount` is what you spend: the base for `sell`, the quote for `buy`.

```bash
cowl markets                    # markets + indicative prices (ETH, USDG, tokenized stocks)
cowl trade sell 4 TSLA-USDG     # spend 4 TSLA from your shielded balance, receive USDG
cowl trade buy 240 NVDA-USDG    # spend 240 USDG, receive NVDA
```

Pricing here is an indicative quote plus the protocol fee; real routing goes through an on-chain DEX
adapter once the pool deploys.

The note format (Poseidon commitments and nullifiers over the BN254 field) is the exact witness the
Noir circuits prove over. **Testnet-first:** until the pool contract deploys, these run against a
local pool on your machine — the cryptography is real, but there is no on-chain transaction or
settlement yet. Point a shared pool file with `COWL_POOL_DIR` to try a multi-party flow locally.

```bash
cowl stake <amount>             # stake $COWL (lights up when the staking contract deploys)
```

---

## File locations

```
~/.cowl/
  keystore.json     # encrypted EVM key   (scrypt + AES-256-GCM, mode 0600)
  viewkey.json      # ed25519 view key    (mode 0600)
  config.json       # network + overrides (mode 0600)
  shielded/
    pool-<net>.json   # local shielded-pool ledger (commitments, nullifiers)
    notes-<net>.json  # your discovered notes
```

Environment overrides: `COWL_HOME` (data directory), `COWL_POOL_DIR` (shared pool ledger),
`COWL_PASSPHRASE` (non-interactive unlock for scripting/CI — never echoed).

---

## Security

- Keys are encrypted at rest with a passphrase; the passphrase is never stored.
- The CLI is non-custodial. You hold your keys; no server can move your funds.
- This is testnet-first software. Do not point it at mainnet funds until the protocol is audited
  and live. See the [disclaimer](https://cowlprotocol.com/disclaimer).

---

## Links

- [Cowl Protocol](https://cowlprotocol.com) — website
- [Docs](https://cowlprotocol.com/docs)
- [GitHub](https://github.com/Cowl-Protocol)

## License

MIT
