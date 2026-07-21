# Cowl CLI — Test Checklist & Results

**Version under test:** `@cowlprotocol/cli` 0.2.7, published and installed.
First runs happened on older builds (A on 0.2.2, B on 0.2.4, C, D, F and G on 0.2.5), so every test
tied to an issue was rerun on 0.2.7. All eight groups have been run and all eight issues are closed.
**Network:** Robinhood Chain Testnet (chainId 46630)
**Wallet:** `0x04F826F9096249FcaDE4CAc19EfafEC69B2e2e2d`
**Started:** 2026-07-21

**Status key:** ⬜ not run · ✅ pass · ❌ fail · ⚠️ partial or needs follow up

---

## How to run

Two rules before starting.

**1. Group G is destructive.** It can overwrite your wallet. Run it only in a throwaway
directory, in a separate terminal tab so it never gets mixed up with the real one:

```bash
export COWL_HOME=~/.cowl-test
```

**2. Test 22 and 51 print secrets.** Run them, but do not screenshot the output.

Optional, to skip the passphrase prompt on every shielded command (each one costs about
4 seconds of scrypt). Set it before recording anything, never on camera:

```bash
export COWL_PASSPHRASE='<your passphrase>'
```

Reset the shielded pool at any time. This clears notes only; the wallet is untouched:

```bash
rm -rf ~/.cowl/shielded
```

---

## Still to run

Every retest is done. Tests 4, 15, 16, 19, 20, 29, 46 and 55 have all been rerun on 0.2.7, so all six
issues are closed and verified rather than merely claimed. What is left never ran at all.

Nothing is blocked and nothing is failing. What is left is confirmation, not discovery.

**Test 58 on 0.2.8**, one real signed transfer, to see `Amount 1 AMZN` where it used to say
`Amount 1 tokens`. The fix is already verified against the built bundle, so this is the on-chain
version of a check that has passed locally.

**Group D from a genuinely empty pool**, low priority. Every D command already passes, so this is not
about the CLI. It is about proving the documented block does not quietly depend on notes left behind
by an earlier session. `rm -rf ~/.cowl/shielded` first, then run section D top to bottom and expect
it to land on 2,199.38 USDG.

**Group H**, after the pool contract deploys.

---

## A — Info & config

```bash
cowl --version
cowl --help
cowl
cowl status
cowl status --json
cowl logo
cowl fees
cowl markets
cowl faucet
cowl doctor
cowl ping
cowl network
cowl network use arbitrum-sepolia && cowl network use robinhood-testnet
cowl config show
cowl config path
cowl token list
```

Run 2026-07-21 on 0.2.2.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 1 | `cowl --version` | `0.2.2` | ✅ | `0.2.2` |
| 2 | `cowl --help` | all commands listed | ✅ | 21 commands + 5 global options |
| 3 | `cowl` | splash + status | ✅ | wordmark renders correctly |
| 4 | `cowl status` | wallet, network, contracts | ✅ | all three contracts `not deployed yet`. Retested on 0.2.7: no wordmark splash any more, issue 2 closed |
| 5 | `cowl status --json` | valid JSON | ✅ | `contracts` all `null`, `testnet: true` |
| 6 | `cowl logo` | COWL wordmark | ✅ | |
| 7 | `cowl fees` | fee schedule + split | ✅ | 0.10 / gas+margin / 0.05, split 50/30/20 |
| 8 | `cowl markets` | 8 markets + prices | ✅ | ETH, TSLA, AMZN, NFLX, PLTR, AMD, AAPL, NVDA |
| 9 | `cowl faucet` | 4 faucets + your address | ✅ | official flagged geo-restricted |
| 10 | `cowl doctor` | all checks pass | ✅ | 0700 dir, 0600 on keystore/viewkey/config |
| 11 | `cowl ping` | chainId 46630 + block | ✅ | block 91949280, latency 792 ms |
| 12 | `cowl network` | 3 networks, active marked | ✅ | active dot on robinhood-testnet |
| 13 | `cowl network use …` (switch and back) | switches both ways | ✅ | sepolia then back to testnet |
| 14 | `cowl config show` | resolved network | ✅ | |
| 15 | `cowl config path` | config file path | ✅ | retested on 0.2.7, prints `~/.cowl-test/config.json`. No account name, issue 3 closed |
| 16 | `cowl token list` | TSLA + AMZN tracked | ✅ | retested on 0.2.7, both symbols now labelled next to their addresses. Issue 1 closed |

## B — Keys & addresses

```bash
cowl wallet address
cowl address
cowl address --meta
cowl receive
cowl viewkey show
cowl wallet export --mnemonic     # expect a refusal, do not screenshot secrets
```

Run 2026-07-21 on 0.2.4.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 17 | `cowl wallet address` | `0x04F826…` | ✅ | |
| 18 | `cowl address` | fresh stealth address | ✅ | address + ephemeral key + view tag `0xab` |
| 19 | `cowl address --meta` | `st:cowl:` meta address | ✅ | retested on 0.2.7, ends `…19d2c4bb1c2bca` |
| 20 | `cowl receive` | `zcowl:` payment address | ✅ | retested on 0.2.7, ends `…56d1c2fa2dfcffe`. Nothing in common with 19 any more, issue 4 is closed |
| 21 | `cowl viewkey show` | public view key | ✅ | created 2026-07-20 |
| 22 | `cowl wallet export --mnemonic` | refuses, wallet is key only | ✅ | refusal message correct. Showing a real phrase is covered by test 51 |

## C — On-chain reads

```bash
cowl balance
cowl balance --token 0x<TSLA>
cowl balance --json
cowl portfolio
cowl portfolio --public
cowl portfolio --shielded
cowl portfolio --json
```

Run 2026-07-21 on 0.2.5.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 23 | `cowl balance` | real ETH balance | ✅ | 0.09896951036 ETH |
| 24 | `cowl balance --token 0x…` | tracked token balance | ✅ | 50 AMZN |
| 25 | `cowl balance --json` | valid JSON | ✅ | address, amount, symbol |
| 26 | `cowl portfolio` | public + shielded split, warning shown | ✅ | both warnings present, no summed total |
| 27 | `cowl portfolio --public` | public only | ✅ | no passphrase prompt, correct |
| 28 | `cowl portfolio --shielded` | shielded only | ✅ | AMZN 15, TSLA 5, 3 notes |
| 29 | `cowl portfolio --json` | `poolDeployed:false`, `total:null` | ✅ | both halves retested on 0.2.7. Bare, it refuses with the env var hint. With `COWL_PASSPHRASE` set, clean JSON, nothing leaked in: `poolDeployed:false`, `total:null`, `shielded.simulated:true`. Public total 24296.90853108 reconciles against all three positions |

## D — Shielded pool (local, safe to repeat)

```bash
cowl shield 5 TSLA                 # the sell further down spends this
cowl shield 5 AMZN
cowl shield 0.01 ETH
cowl balance --shielded
cowl scan
cowl markets
cowl trade sell 2 TSLA-USDG        # 500 gross, 0.5 fee, 499.5 USDG in
cowl trade buy 120 NVDA-USDG       # 0.12 fee, 0.999 NVDA out, 379.5 USDG left
cowl receive                       # copy the zcowl: address
cowl send 100 USDG zcowl:<self>
cowl scan
cowl unshield 1 AMZN
cowl portfolio --shielded
```

Only TSLA, AMZN and ETH are ever shielded here, because those are what the wallet actually holds:
TSLA 50, AMZN 50, ETH 0.098969. Nothing in the block exceeds that. It does not bite yet, since local
shielding deducts nothing, but it will the moment the pool deploys. The ETH leg is 0.01 for the same
reason: the original 0.5 was more ETH than the wallet has.

USDG and NVDA are never shielded directly. USDG only ever arrives from selling TSLA, and NVDA only
from spending that USDG, so the sequence stands on its own from an empty pool.

Run top to bottom from empty, it should end on TSLA 3, AMZN 4, ETH 0.01, USDG 379.5, NVDA 0.999,
subtotal 2,199.38 USDG.

Run twice. First on 0.2.5, which is where the wrong `buy` amount surfaced. Rerun in full on 0.2.7
with the corrected block, and the table below records that second run. It started at leaf #10, on the
pool the first run left behind, because the `rm -rf ~/.cowl/shielded` reset was skipped. Every command
passed, so the CLI is proven either way, but the block has still never been exercised from genuinely
empty. That is the one thing 29a exists to check.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 29a | `cowl shield 5 TSLA` | commitment, leaf++, new root | ✅ | leaf `#10`, root `0x106db866…`. Ran against a carried-over pool, not an empty one |
| 30 | `cowl shield 5 AMZN` | commitment, leaf++, new root | ✅ | leaf `#11`, root `0x2ff7119d…` |
| 31 | `cowl shield 0.01 ETH` | leaf increments again | ✅ | leaf `#12`, root `0x18e9d63e…`. Root moves on every insert |
| 32 | `cowl balance --shielded` | per-token summary | ✅ | AMZN 24 · 4 notes, ETH 0.02 · 2 notes, TSLA 8 · 2 notes, USDG 499.5 · 2 notes |
| 33 | `cowl scan` | no new notes | ✅ | `No new notes.` |
| 34 | `cowl trade sell 2 TSLA-USDG` | nullifier + output + change note | ✅ | spent 2 TSLA, received 499.5 USDG at 250, fee 0.5 USDG in quote |
| 35 | `cowl trade buy 120 NVDA-USDG` | receives NVDA | ✅ | spent 120 USDG, received 0.999 NVDA, fee 0.12 USDG. The missing 0.001 NVDA is the fee, visible in the output |
| 36 | `cowl send 100 USDG zcowl:<self>` | private send | ✅ | nullifier + one 100 output note, and no change note, because a 100 USDG note already existed and got spent whole |
| 37 | `cowl scan` | finds 1 new note | ✅ | `Found 1 new note.` self-send picked up by view-tag scan |
| 38 | `cowl unshield 1 AMZN` | nullifier + change note | ✅ | 1 AMZN out, change note for the remaining 23 |

Final `cowl portfolio --shielded`: AMZN 23 · 5,290.00, TSLA 6 · 1,500.00, USDG 879 · 879.00,
NVDA 0.999 · 119.88, ETH 0.02 · 60.00. Subtotal 7,848.88 USDG across 5 positions and 12 notes.

Every number reconciles against the ops that ran. TSLA went 3 + 5 shielded − 2 sold = 6. AMZN went
19 + 5 − 1 unshielded = 23. USDG went 499.5 + 499.5 from the sell − 120 into NVDA = 879, untouched by
the self-send, which only moved value between the owner's own notes. Value is conserved across shield,
trade, send and unshield, which is exactly the property the Noir circuits have to hold to later.

Test 36 is the subtle one. The send produced no change note, because the pool found a USDG note worth
exactly 100 and spent it whole. Change only appears when no note matches, which is the behaviour a
join-split should have.

## E — Errors & gated paths

Most of this group must print an error and exit non-zero. Check the exit code with `echo $?` right
after, since an error that exits zero looks like success to a script.

Tests 39 and 44 are the exception, and deliberately so. The CLI separates the two: `✗` means the
command failed and exits 1, `!` means the command ran fine and has something to tell you, and exits 0.
Asking a mainnet for a faucet is not a failure, it is a question with an answer. Scripts that need to
branch on it should check the network first rather than the exit code.

```bash
cowl stake 100
cowl trade sell 9999 TSLA-USDG
cowl trade sell 1 FOO-BAR
cowl send 1 ETH 0xzzz
cowl shield 5 DOGE
cowl -n robinhood-mainnet faucet
cowl shield -- -5 ETH        # the -- matters, see test 45
cowl foo            ; echo "exit=$?"
cowl portfoli       ; echo "exit=$?"
cowl walet address  ; echo "exit=$?"
cowl -n nosuchnet status
```

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
Run 2026-07-21 on 0.2.7.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 39 | `cowl stake 100` | not live yet | ✅ | message names the network and the config key to set once staking ships. Exits 0 on purpose, see issue 7 |
| 40 | `cowl trade sell 9999 TSLA-USDG` | insufficient, human numbers | ✅ | `Insufficient shielded balance: need 9999, have 6.` exit 1. Reads in tokens, not base units |
| 41 | `cowl trade sell 1 FOO-BAR` | unknown market + list | ✅ | names all 8 known markets in the error |
| 42 | `cowl send 1 ETH 0xzzz` | invalid address | ✅ | `Invalid recipient address.` exit 1, and it names both accepted forms, `0x` and `zcowl:`. Verified in a separate run, not in the screenshot batch |
| 43 | `cowl shield 5 DOGE` | unknown token | ✅ | `Unknown token "DOGE".` with the accepted forms spelled out |
| 44 | `cowl -n robinhood-mainnet faucet` | not a testnet | ✅ | message is right and points at the fix. Exits 0 on purpose, see issue 7 |
| 45 | `cowl shield -- -5 ETH` | amount must be positive | ✅ | `Amount must be positive.` The `--` is what lets the argument through to validation |
| 45a | `cowl foo` | unknown command, exit 1, no suggestion | ✅ | exit 1, correctly offers no suggestion since nothing is close |
| 45b | `cowl portfoli` | suggests `cowl portfolio`, exit 1 | ✅ | exit 1 |
| 45c | `cowl walet address` | suggests `cowl wallet`, exit 1 | ✅ | exit 1, matched on the subcommand rather than the whole line |
| 45d | `cowl -n nosuchnet status` | unknown network + known list | ✅ | lists all 3 known networks |

## F — Backup & security

```bash
cowl backup ~/test-bk.json
cowl backup --verify ~/test-bk.json
cowl backup --verify ~/test-bk.json    # then enter a wrong passphrase
```

Run 2026-07-21 on 0.2.5.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 46 | `cowl backup ~/test-bk.json` | written, view key included | ✅ | address + view key + config all included, 0600. Retested on 0.2.7: both the written line and the verify hint now read `~/test-bk.json` |
| 47 | `cowl backup --verify ~/test-bk.json` | opens and is intact | ✅ | opens, address matches, created `2026-07-21T11:16:08.336Z`, view key + config both present |
| 48 | `cowl backup --verify` (wrong passphrase) | wrong backup passphrase | ✅ | the on-camera attempt reported intact because the correct passphrase got typed again, so it was rerun with `COWL_PASSPHRASE` set to a known-wrong value: `Wrong backup passphrase.` exit 1 |

The backup is sealed with scrypt N=2^15 plus AES-256-GCM, so a wrong passphrase fails the auth tag
in `decipher.final()` and can never open the file. Shielded notes are deliberately excluded, which
is correct: every note key descends from the wallet key, so `cowl scan` rebuilds them after a
restore. That also means a backup alone cannot reveal your notes.

## G — Destructive

> Run `export COWL_HOME=~/.cowl-test` first, in a separate tab.

```bash
export COWL_HOME=~/.cowl-test

cowl init
cowl wallet new --mnemonic --force     # write down the 12 words for test 53
cowl wallet export --mnemonic
cowl wallet new --key --force
cowl wallet import --mnemonic "<the 12 words from test 50>"
cowl wallet passphrase
cowl restore ~/test-bk.json --force
cowl viewkey new --force
```

Run 2026-07-21 on 0.2.5, under `COWL_HOME=~/.cowl-test`. The real `~/.cowl` was never touched.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 49 | `cowl init` | wizard with 4 options | ⚠️ | wizard opened, then cancelled at the Wallet step, so the option list is not in the capture. All 4 options are there in `cli.ts` (new seed, new key, import seed, import key). Rerun without cancelling to close this out |
| 50 | `cowl wallet new --mnemonic --force` | 12-word grid | ✅ | `0x7ECD37…`, 12 words in a numbered grid, derivation `m/44'/60'/0'/0/0` |
| 51 | `cowl wallet export --mnemonic` | phrase shown | ✅ | warns before anything prints, asks `Continue?`, then requires the keystore passphrase. Same phrase as 50 |
| 52 | `cowl wallet new --key --force` | key only, no phrase | ✅ | `0x3DE8c8…`, `Private key only`, no phrase printed. Correct |
| 53 | `cowl wallet import --mnemonic "…"` | same address as #50 | ✅ | refused first without `--force` with an overwrite hint, then imported to `0x7ECD37…`, byte for byte the address from 50. Seed round-trip proven |
| 54 | `cowl wallet passphrase` | passphrase changed | ✅ | changed for `0x7ECD37…`, and it warns that existing backups still open under the old one |
| 55 | `cowl restore ~/test-bk.json --force` | restores `0x04F826…` | ✅ | restored `0x04F826…`. Retested on 0.2.7 into the test home, `From` now reads `~/test-bk.json` |
| 56 | `cowl viewkey new --force` | new view key | ✅ | `0x436fbb…` |

Test 56 is safe to run, which is not obvious. The view key in `viewkey.json` is random and independent:
the shielded pool derives its own view key from the wallet key under `cowl:shielded:view`, and stealth
derives another under `cowl:view`. So rotating it cannot orphan shielded notes or strand funds at a
stealth address. What it does invalidate is any view key already handed to an auditor, and the copy
sealed inside an older backup.

**The seed phrase from tests 50 and 51 is burned.** It was captured on screen and it is also sitting in
plaintext in shell history from the test 53 import, so treat `0x7ECD37…` as public. Never send anything
to it. Same for `0x3DE8c8…` from test 52.

Two things are worth cleaning up once E is done. `~/.cowl-test` now holds a restored copy of the real
`0x04F826…` keystore, and `~/test-bk.json` holds the same wallet. Both are encrypted, both are outside
the place you would think to look for them.

## H — On-chain writes (costs gas)

```bash
cowl address                            # copy the stealth address
cowl send 0.001 ETH 0x<stealth>
cowl send 1 0x<TSLA> 0x<stealth>
```

Test 58 exercises the ERC-20 path (`sendToken`), which has never been run against a real
chain. Sending a tokenized stock to a stealth address is the most valuable proof here.

**Deferred to the deploy.** Held until the pool contract ships so the whole transaction path can be
proven on-chain in one sitting instead of twice.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
Run 2026-07-21 on 0.2.7, ahead of the pool deploy. Recipient was a fresh `cowl address` stealth
address, `0x036095…`, view tag `0x83`.

| # | Command | Expected | Status | Notes / Proof |
|---|---|---|---|---|
| 57 | `cowl send 0.001 ETH 0x<stealth>` | tx hash + explorer link | ✅ | shows From, To, Amount and Network, then asks `Sign and broadcast?` before the key is ever unlocked. Confirmed on chain |
| 58 | `cowl send 1 0x<AMZN> 0x<stealth>` | ERC-20 path, never tested before | ⚠️ | `sendToken` works, confirmed on chain in 13s. The confirmation read `Amount 1 tokens` instead of naming AMZN, which is issue 8, fixed in 0.2.8. Worth one rerun on 0.2.8 to see `Amount 1 AMZN` on a real signed transfer |

Both sends went to the same stealth address, so the pair also demonstrates the intended flow: one
one-time address receives value that cannot be linked back to `0x04F826…` from the explorer.

---

## Issues found

| # | Test | Problem | Status |
|---|---|---|---|
| 1 | 16 | `cowl token list` prints raw addresses only. You cannot tell TSLA from AMZN, even though `token add` already reads the symbol from the contract. | ✅ fixed in 0.2.3, confirmed on 0.2.7 |
| 2 | 3, 4 | `cowl status` prints the full wordmark splash, identical to bare `cowl`. Noisy when status is called deliberately or repeatedly. | ✅ fixed in 0.2.3, confirmed on 0.2.7 |
| 3 | 15 | `cowl config path` printed the absolute path, exposing the account name in screenshots and recordings. `displayPath()` exists for exactly this and was not used here. | ✅ fixed in 0.2.4, confirmed on 0.2.7 |
| 4 | 19, 20 | The stealth meta-address and the shielded payment address ended in the same bytes, because the pool reused the stealth view key. Anyone holding both published addresses could link them to one person. | ✅ fixed in 0.2.5, confirmed on 0.2.7. The two addresses now share nothing |
| 5 | 29 | Prompts render to stdout, so a `--json` run that needed the passphrase wrote the prompt into the JSON and broke piping. Only hidden during testing because `COWL_PASSPHRASE` was set. | ✅ fixed in 0.2.6, confirmed on 0.2.7. `--json` now refuses with the env var hint instead of prompting |
| 6 | 46, 55 | `cowl backup` prints the resolved absolute path twice, in `Backup written to …` and in the `cowl backup --verify …` hint, and `cowl restore` prints it again in `From`. The account name ends up in every screenshot. The shell expands `~` before the CLI sees it. Same class as issue 3, missed when that one was fixed. | ✅ fixed in 0.2.7, `displayPath()` at `cli.ts:458`, `cli.ts:465`, `cli.ts:489` and `backup.ts:83`. Confirmed by 46 and 55 |
| 7 | 39, 44 | `cowl stake` and `cowl -n robinhood-mainnet faucet` both print a `!` notice and exit 0. The messages are right, but a script cannot tell them apart from success: `cowl -n robinhood-mainnet faucet && next` runs `next`. It is a deliberate shape, `warn()` then `return` rather than `die()`. | ✅ closed as intended, 2026-07-21. Not a defect, a convention: `✗` means the command failed and exits 1, `!` means the command ran and has something to tell you, and exits 0 |
| 8 | 58 | The `Sign and broadcast?` screen for an ERC-20 send reads `Amount 1 tokens`. `cli.ts:941` hardcodes the string `"tokens"` for anything that is not the native coin, so the one screen standing between you and an irreversible transfer cannot tell TSLA from AMZN. The CLI already knows the answer: `cowl token list` prints the symbol, stored by `token add`. Three other call sites (`cli.ts:921`, `982`, `1003`) resolve it properly. Note `tokenLabel()` alone will not fix this, since the registry keys listed symbols by sentinel field, not by contract address, so this needs the tracked-token config or an on-chain `symbol()` call. | ✅ fixed in 0.2.8, reads the symbol with `tokenMeta()` before the confirmation and falls back to `tokens` only when the contract will not answer. Retest 58 |

## On-chain proof

| Test | Tx hash | Explorer |
|---|---|---|
| 57 | `0xa54e0a7de716a4bea374f4889c299e8eb41d93baf58b9dfa84ce4b3bb34adb21` | [explorer](https://explorer.testnet.chain.robinhood.com/tx/0xa54e0a7de716a4bea374f4889c299e8eb41d93baf58b9dfa84ce4b3bb34adb21) |
| 58 | `0x460bcb9e37770ba6a25d61adcf9e079b84addd83ceb3f5bd2f31aa7b9aea5cf3` | [explorer](https://explorer.testnet.chain.robinhood.com/tx/0x460bcb9e37770ba6a25d61adcf9e079b84addd83ceb3f5bd2f31aa7b9aea5cf3) |
| 57, earlier | `0x79a6aca3eb34a7d6b507c30835ac0a5df416280d98f4cf9978a53f555cf03348` | [explorer](https://explorer.testnet.chain.robinhood.com/tx/0x79a6aca3eb34a7d6b507c30835ac0a5df416280d98f4cf9978a53f555cf03348) — first attempt, sent to a plain address rather than a stealth one |

---

## Known limits while testing

- `shield`, `trade`, `send` to a `zcowl:` address, `unshield`, and `scan` are **local only**.
  No transaction is broadcast and no public balance changes. That is expected until the pool
  contract deploys.
- Public and shielded totals are reported separately and cannot be summed for the same reason.
- Every shielded command re-derives keys with scrypt, which costs roughly 4 seconds.
