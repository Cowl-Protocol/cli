# Cowl Mainnet — Smoke Test Log

**Version under test:** `@cowlprotocol/cli` 0.6.3, published to npm and installed globally — with
the trade leg landing on the 0.6.4 build, which carries the one fix this test itself produced.
**Network:** Robinhood Chain (chainId 4663) — mainnet, real ETH.
**Pool:** `0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E`
**Adapter:** `0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98` · venue: the chain's live Uniswap V3
**Wallets:** A `0x04F826F9096249FcaDE4CAc19EfafEC69B2e2e2d` · B `0x0f02AdCB7d6d8871ad9555A7f0d90F5faE69A7a6`
**Run:** 2026-07-24, started and finished the same day.

**Status key:** ⬜ not run · ✅ pass · ❌ fail · ⚠️ partial or needs follow up

Every leg of the private lifecycle ran on mainnet with real ETH: shield, two cross-wallet private
sends, a private trade through live public liquidity, and the unshield that closes the round trip.
Every transaction hash is linked at the bottom so the whole run can be replayed from the explorer.

---

## How to run

Three things to know before repeating this.

**1. RPC.** The official endpoint is geo-restricted in some regions. If it does not serve yours,
point the CLI at any Robinhood Chain mainnet RPC — the override is stored per network, so testnet
keeps its own:

```bash
cowl network use robinhood-mainnet
cowl config set rpcUrl <your-rpc-url>
```

**2. Two identities on one machine.** The cross-wallet tests need a second wallet, and the CLI
supports isolated profiles via `COWL_HOME`. Run the second identity in its own terminal tab:

```bash
export COWL_HOME=~/.cowl-counterpart
cowl init
```

Config, keystore, view key and notes all live inside that directory. The variable is per tab and
does not persist, which is the safety property: you cannot end up in the wrong wallet without
typing the export yourself.

**3. Mainnet spends are self-pay.** There is no default relayer on 4663 yet, so every
proof-carrying transaction pays its own gas at the spending wallet. Budget roughly 4M gas for a
shield or a send and under 9M for a trade.

---

## A — Setup & reads

```bash
cowl -v
cowl network use robinhood-mainnet
cowl status
cowl ping
cowl balance
cowl receive
```

Run on 0.6.3, tab A.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 1 | `cowl -v` | published version | ✅ | `0.6.3`, resolved from the global npm install |
| 2 | `cowl network use robinhood-mainnet` | switches to 4663 | ✅ | active network `robinhood-mainnet` |
| 3 | `cowl config set rpcUrl …` | override saved on mainnet only | ✅ | testnet RPC untouched, confirmed by switching back later |
| 4 | `cowl status` | wallet, network, pool | ✅ | chain 4663, pool `0x6f98…6a3E`. The relayer line reads `not deployed yet` even where a relay is live — see issue 2 |
| 5 | `cowl ping` | chainId + block + latency | ✅ | chainId 4663, block 18193420, 905 ms |
| 6 | `cowl balance` | funded amount | ✅ | 0.02 ETH |
| 7 | `cowl receive` | `zcowl:` payment address | ✅ | derived cleanly; reused as the recipient in test 14 |

## B — Entry: the first mainnet leaf

```bash
export COWL_HOME=~/.cowl-counterpart
cowl init
cowl wallet import                  # second wallet's key — never screenshot this
cowl network use robinhood-mainnet
cowl status
cowl balance
cowl shield 0.001
cowl balance --shielded
cowl scan
```

Run on 0.6.3, tab B, wallet B. This group put the first ETH ever into the mainnet pool.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 8 | `cowl init` under `COWL_HOME` | isolated profile | ✅ | fresh profile with its own config, keystore, view key and `shielded/` |
| 9 | `cowl wallet import` | wallet B becomes active | ✅ | `0x0f02Ad…A7a6` active in tab B only. Verified after the fact: tab A still answers `0x04F826…` |
| 10 | `cowl status` + `cowl balance` on the profile | own network config | ✅ | profile carries its own RPC setting. 0.01697 ETH public |
| 11 | `cowl shield 0.001` | commitment, leaf #0, new root | ✅ | **leaf `#0`**, commitment `0x13a88340…6b30`, root `0x151eaa97…6442`, gas 4,074,441. First real ETH in the pool |
| 12 | `cowl balance --shielded` | note decrypts | ✅ | 0.001 ETH · 1 note, synced 1 leaf |
| 13 | `cowl scan` | no new notes | ✅ | `No new notes.` The note from its own shield was already indexed |

## C — Two-party private transfer

```bash
# tab B
cowl send 0.0005 ETH zcowl:<wallet A's address from test 7>
cowl scan

# tab A
cowl balance --shielded
```

Two independent wallets, one pool — strictly stronger than a self-send.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 14 | `cowl send 0.0005 ETH zcowl:<A>` | nullifier + two output leaves | ✅ | spent note `#0`, output leaves `#1` and `#2`, root `0x2650842d…e169`, gas 4,365,268. The join-split split 0.001 into 0.0005 to the recipient and 0.0005 change |
| 15 | `cowl balance --shielded` (tab A) | A claims exactly one note | ✅ | synced 2 new leaves, 3 total, and reports **0.0005 ETH · 1 note**. B's change leaf is visible on chain but not claimable, so it is correctly ignored |
| 16 | `cowl scan` (tab B, twice) | idempotent, claims nothing new | ✅ | `Synced · 3 leaves` then `No new notes`, both runs. B does not see the note it paid away, and cannot open the leaf it does not own |

Value reconciles exactly. The pool contract holds 0.001 ETH, which is the whole shield, and the two
live notes are 0.0005 at wallet A plus 0.0005 change at wallet B. One nullifier is spent, three
leaves exist, and nothing was created or destroyed in between.

The privacy property holds on both sides. Tab A synced two new leaves and claimed one; tab B synced
three and claimed none. Neither wallet can read the other's note, and the explorer shows only a
proof and two ciphertexts, with no sender, recipient or amount anywhere in the transaction.

Worth noting what wallet A did **not** do: at this point it had never signed a mainnet transaction.
Its public balance was still 0.02 ETH untouched. Receiving privately costs the recipient nothing
and leaves no trace at their address.

## D — The private trade

```bash
# tab A — holds 0.0005 ETH shielded, public ETH for gas
cowl trade 0.1 USDG
cowl balance --shielded
```

`trade` spends a shielded note, swaps through the live Uniswap V3 pool via the adapter, and
re-shields the proceeds in one atomic transaction. It landed on the third attempt, and the first
two failures were the useful kind: both failed closed at simulation, with nothing broadcast, no
gas spent, and no nullifier consumed. Attempt one found issue 4 — a real bug, fixed the same day.
Attempt two was a local RPC hiccup.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 17 | `cowl trade 0.1 USDG` | atomic spend → exactOutput → re-shield | ✅ | **the first real-money private trade.** Landed at block 18247374: spent note #1, received exactly 0.1 USDG at leaf #5, ETH change at #3, root `0x180e03eb…3836`, gas **8,599,108**. The receipt tells the whole atomic story in 19 logs: two nullifiers and three note pairs at the pool, WETH wrap/approve/pull, a real `Swap` on the WETH/USDG 0.05% pool, USDG straight back into the shielded pool, and the adapter's `Traded`. The slippage headroom refund is visible in the balance arithmetic: gas cost 0.001003447 ETH, but the public wallet dropped only 0.001002906 — the difference is the unused input cap refunded by the adapter. Execution filled slightly below quote |
| 18 | `cowl balance --shielded` | 0.1 USDG + reduced ETH note | ✅ | USDG 0.1 · 1 note and ETH 0.000945602201671059 · 2 notes across 8 synced leaves — exactly the trade change plus a bonus second cross-wallet receive: wallet B sent its whole remaining change note (leaves #6+#7, gas 4,365,328). The note matched the amount exactly, so the second output is the zero filler — the same join-split behaviour the testnet log proved in its test 36 |

## E — Exit: unshield

```bash
cowl unshield 0.0002          # expect a refusal — 0.0002 is under the smallest denomination
cowl unshield 0.0002 --exact
cowl balance
```

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 19 | `cowl unshield 0.0002` | denomination guard, then `--exact` lands it | ✅ | the bare command correctly refused: `0.0002 ETH is below the smallest denomination, 0.001 ETH`, with the fingerprint explanation and the `--exact` hint — the boundary-privacy default works on mainnet. `--exact` then landed it: spent note #3, change + filler at leaves #8+#9, root `0x2428d425…0478`, gas 4,376,528 |
| 20 | `cowl balance` | public ETH increases | ✅ | 0.018690441032113664 ETH exact: 0.018997 before + 0.0002 unshielded − 0.000511 gas. Cross-checked with `cowl portfolio`: shielded 0.000745602… ETH + 0.1 USDG across 3 notes, 10 leaves. Round trip closed |

## F — Read-only checks

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 21 | `cowl markets` | market list + prices | ⚠️ | renders all 8 markets, but the prices are still the local simulation, not the live quoter the trade path already uses. Issue 1 |
| 22 | `cowl portfolio` | public + shielded split | ✅ | public and shielded rendered as separate books, with the "% of your book is off the explorer" line |
| 23 | `cowl fees` | fee schedule | ✅ | full schedule renders on mainnet: 0.10% trade / gas+margin relayer / 0.05% unshield, 50-30-20 staker–burn–treasury split, labelled indicative |
| 24 | `cowl doctor` | no complaints | ✅ | 0700 data dir, 0600 keystore/viewkey/config, wallet correct. A second `COWL_HOME` profile does not confuse it |
| 25 | `cowl address` | fresh stealth address | ✅ | one-time address + ephemeral pubkey + view tag, with the unlinkability note |

---

## Issues found

| # | Test | Problem | Status |
|---|---|---|---|
| 1 | 21 | `cowl markets` prints simulated indicative prices rather than quoting the chain. On mainnet the QuoterV2 is live and `trade` already prices through it, so the one command a trader would check before trading is the one that lags reality. | ⬜ open, next release: route `markets` through the same quote path as `trade` |
| 2 | 4 | `cowl status` reads the on-chain relayer *contract* slot, so it prints `not deployed yet` even on a network where the off-chain relay service is live and is the default for boundary spends. | ⬜ open, next release: show the relay URL when one is configured, and label the contract slot separately |
| 3 | 5 | The official mainnet RPC is geo-restricted in some regions, and mainnet ships no public fallback — testnet already falls back automatically. A user in a restricted region gets timeouts with no hint about why. | ⬜ open, next release |
| 4 | 17 | `cowl trade` sized the spend value — the swap's hard input cap, fixed at proving time — as the bare quote with zero slippage headroom. Fine against a fixed-price test venue, but a live venue moves during the seconds a proof takes to build, so the first mainnet trade reverted `STF` in the router the moment the price ticked against it. It failed closed at gas estimation: nothing broadcast, no gas spent, nullifiers untouched. | ✅ fixed in 0.6.4: self-submitted trades add 1% headroom, and the adapter refunds the unused part to the submitter — which on a self-submitted trade is the trader's own wallet. Relayed trades keep the bare quote so the refund cannot become a stray tip. `--max` still overrides. Retested on-chain: test 17 |

Issues 1–3 are reporting-surface issues. Issue 4 was a real trade-path bug, caught exactly the way
a smoke test should catch it — failing closed, with funds untouched — and shipped fixed in 0.6.4
the same day.

## On-chain proof

| Test | What | Tx |
|---|---|---|
| 11 | the first shield, leaf #0 | [`0xcd419567…d6310`](https://robinhoodchain.blockscout.com/tx/0xcd419567f6073731ee5a7919d1a165500fc14ba5d187395914c1c17a8ddd6310) |
| 14 | the first cross-wallet private send | [`0x97b20238…122b8`](https://robinhoodchain.blockscout.com/tx/0x97b20238233ad1906aea393e442d5f577f99ec6ff6049386efec5c11370122b8) |
| 18 | the second private send (exact-match note) | [`0x92daf308…682df`](https://robinhoodchain.blockscout.com/tx/0x92daf3087a7400b401e906557fe26c7e4f4e06f0b6eaab3f7674ba08dd9682df) |
| 17 | **the first real-money private trade** | [`0x1e2828a2…4b811`](https://robinhoodchain.blockscout.com/tx/0x1e2828a23f428552ca062035035df8cf82e592cde3d923ac9fa109e14134b811) |
| 19 | the unshield that closed the round trip | [`0x8b241703…be88c`](https://robinhoodchain.blockscout.com/tx/0x8b241703c7b5da3a1d89a473d9ba835eacdcbc8fba27956a2ec1a4ed7d4be88c) |

Open any of them: what the chain shows is a proof, ciphertexts, and nothing else — no sender, no
recipient, no amounts inside the pool.

## Where the run ended

| Where | Public ETH | Shielded |
|---|---|---|
| Wallet A | 0.018690441032113664 | 0.000745602… ETH + 0.1 USDG · 3 notes |
| Wallet B | 0.01503 | empty — spent its whole book across the two sends |
| Pool | 0.000745602… ETH + 0.1 USDG held | 10 leaves, 4 nullifiers spent |

The pool's balance and the sum of every live note agree to the wei, across a shield, two sends, a
trade and an unshield. That conservation held is the whole point: it is the invariant the circuits
exist to enforce, and mainnet now shows it holding with real money.

## Known limits

- **No relayer on mainnet yet.** Every spend is self-pay, so the spending wallet's address appears
  as the transaction sender. Testnet already routes spends through a public relay by default; the
  mainnet relayer is next in line.
- **`zcowl:` addresses only work inside `cowl send`.** They are not on-chain accounts — a plain
  wallet transfer cannot pay one, and a public 0x transfer never touches the pool.
- Every shielded command re-derives keys with scrypt, which costs a few seconds before any proving
  starts.
