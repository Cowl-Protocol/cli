# @cowlprotocol/cli

Terminal CLI for [Cowl Protocol](https://cowlprotocol.com) — private trading on Robinhood Chain.

Manage a local wallet, generate one-time **stealth addresses**, hold **view keys** for
selective disclosure, read balances, send funds, and check the **fee** schedule — all from your
terminal. Testnet-first: everything that can be real today is real; on-chain shielded-pool
operations light up as the protocol contracts deploy.

## Install

```bash
npm install -g @cowlprotocol/cli
```

Requires **Node.js 18+**. The command is `cowl`.

---

## Quick start

```bash
cowl init                 # create a wallet + view key, pick a network
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

Robinhood Chain is an Arbitrum-based L2. Until its public testnet ships, **Arbitrum Sepolia** is
the working default, so reads and connectivity are real today. Everything is overridable.

```bash
cowl network                    # list networks (active is marked)
cowl network use <key>          # switch active network

cowl config show                # resolved network + contract addresses
cowl config set rpcUrl <url>    # override the RPC
cowl config set contracts.pool 0x…      # set a contract address once deployed
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

## Shielded pool (testnet-first)

Deposits, private trades, withdrawals, and staking run against the on-chain Cowl contracts. Until
those are deployed on a public network, these commands report their status and the config needed to
point them at a deployment:

```bash
cowl shield <amount> [token]    # deposit into the shielded pool
cowl unshield <amount> [token]  # withdraw
cowl trade <side> <amount> <market>
cowl stake <amount>             # stake $COWL
```

---

## File locations

```
~/.cowl/
  keystore.json     # encrypted EVM key   (scrypt + AES-256-GCM, mode 0600)
  viewkey.json      # ed25519 view key    (mode 0600)
  config.json       # network + overrides (mode 0600)
```

Override the directory with `COWL_HOME`.

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
