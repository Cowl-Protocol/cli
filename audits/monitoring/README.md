# Monitoring — governance and turnstile

Audit plan Step 3, brought forward. Every other phase protects code that has not
run yet; this one watches the balance sitting in the pool right now.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Check | Last read |
|---|---|---|
| 🟢 | Turnstile exact, every token that entered through `shield()` | exact to the wei, both pools |
| 🟢 | Pool owner unchanged | matches the recorded baseline |
| 🟢 | Both verifier addresses unchanged | match the recorded baseline |
| 🟢 | No verifier swap pending, either kind | none |
| 🟢 | The alarm actually fires | proven against simulated drift |
| 🟡 | Nothing schedules the watcher | run by hand; a VPS timer needs a deploy |
| 🟡 | The relayer float is not watched | daemons already report `floatWei` and `spendsLeft` in every quote, so the check is one HTTP GET |
| 🟡 | No notification channel | an alarm nobody is told about is a log entry |

**The pool has no pause.** If this alarms, the levers are: stop the relayers,
banner the app, tell people to withdraw self-paid. That is the whole playbook and
it is written out below.

The three 🟡 rows are the same gap seen from three sides — the watcher is built
and proven, and nothing runs it on a clock or tells anyone when it speaks.

```
npm run watch                                  # every network with a pool
npm run watch -- --network robinhood-mainnet
npm run watch -- --update                      # re-record the baseline from chain
```

Exit codes: **0** clean, **1** something to look at, **2** could not check. Those
last two are deliberately different — a watcher that cannot tell "nothing wrong"
from "could not tell" is not a watcher, and on this chain the RPCs fail often
enough that it matters.

Implementation and the reasoning behind it: [`../../scripts/watch-pool.mjs`](../../scripts/watch-pool.mjs).
Short version — it reads **state**, not events. A log subscription on
`VerifierSwapProposed` is the obvious build and the wrong one here: publicnode
refuses historical `eth_getLogs` and the only archive source rate-limits to
about one request per window, so a log-based watcher on Robinhood Chain is
either blind or throttled, and it fails quiet. `pendingSwap()` answers the same
question as current state, and a changed `shieldVerifier()` catches a swap that
already executed even if the proposal was never seen.

## `pool-baseline.json`

What governance looked like when a human last confirmed it. Drift is only
detectable against a recorded expectation, so this file is the whole mechanism —
**commit it, and only regenerate it deliberately.**

`--update` merges rather than overwrites, and it only rewrites networks that
actually answered, so a dead RPC cannot quietly erase a baseline and make the
next run look clean.

Recorded 2026-07-28, both pools reachable:

| | mainnet `0x6f98666e…6a3E` | testnet `0xf9F825f2…2A59` |
|---|---|---|
| owner | `0xd5F69BCf…2eff` | `0xd5F69BCf…2eff` |
| shield verifier | `0x0D6E2e89…065fC` | `0xB75c5659…0ba9` |
| transfer verifier | `0x18670646…1275E` | `0xBA945Bf3…4239` |
| pending swaps | none | none |
| watched tokens | native + 5 | native + 2 |

The turnstile was **exact on every token that entered through `shield()`** —
ETH, COWL, AAPL and USDG all had `pooledValue` equal to the pool's real balance
to the wei. DIH and the lookalike USDG `0x2CE3E396…` sit at `pooledValue` 0
against a nonzero balance: they arrived by plain transfer, never through
`shield()`, so nobody can withdraw them. They are watched precisely because
`pooledValue` becoming nonzero for either one without a deposit would be alarming.

## What to do when it fires

An alert with no response is a death notification. The pool is **immutable and
has no pause**, so the levers are off-chain and they are these, in order.

### `VERIFIER SWAP PENDING`

The pool's only drain vector. A verifier that accepts anything makes every
forged proof valid, and `ExceedsPooledValue` then caps the damage at all of
`pooledValue` — which is everything. `VERIFIER_SWAP_DELAY` is **7 days** and
nothing shortens it, so the alert is the start of a fixed window, not an
emergency.

1. **Was it you?** The owner key is a single deployer EOA. If the proposal was
   not deliberate, treat the key as compromised.
2. If it was not deliberate, the owner can still call `cancelVerifierSwap` —
   *if* the key is still yours. Try that first.
3. If the key is gone, the 7 days belong to the depositors. Stop the relayers,
   put a notice on the app, and tell people to withdraw. Withdrawal does not
   need the relayer or our infrastructure; the CLI can spend self-paid against
   the pool directly.

### `TURNSTILE SHORT`

The pool owes more of a token than it holds. Two causes, and the response is the
same for both because you cannot tell them apart quickly:

- a drain in progress, or
- a fee-on-transfer token was shielded — the deposit credits face value while
  delivering less (see [`../static/README.md`](../static/README.md)).

**Stop the relayers first.** They are the one piece of the flow we control, and
stopping them removes the gasless path without touching anyone's funds. Then
check which token is short: if it is one nobody deposited through `shield()`,
the blast radius is that token alone — the turnstile is per token by design and
COWL, AAPL, USDG and ETH cannot bleed into each other.

### `owner CHANGED`

Ownership moved. If it was not you, every other check in the run is
untrustworthy, because whoever holds the key can propose a swap at will. Same
response as an undeliberate pending swap, minus the option to cancel.

## Not yet done

- **Nothing runs this on a schedule.** It is a one-shot check built to be
  cron- or timer-friendly, and it has only ever run by hand. Putting it on the
  VPS beside the relayers is the obvious next step and needs a deploy.
- **No notification channel.** Exit code 1 tells a shell, not a person.
- **Relayer float is not watched.** Mainnet was at roughly 239 spends of
  headroom when this was written; when it empties, gasless stops working for
  everyone with nothing on chain to say why. Different failure from the two
  above — availability, not theft — but the same cheap shape of check.
