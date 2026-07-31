# Monitoring — governance, turnstile and the relayer

Audit plan Step 3, brought forward. Every other phase protects code that has not
run yet; this one watches the balance sitting in the pool right now, and the one
piece of infrastructure the whole gasless path depends on.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Check | Last read 2026-07-31 |
|---|---|---|
| 🟢 | Turnstile exact, every token that entered through `shield()` | exact to the wei, both pools |
| 🟢 | Pool owner unchanged | matches the recorded baseline |
| 🟢 | Both verifier addresses unchanged | match the recorded baseline |
| 🟢 | No verifier swap pending, either kind | none |
| 🟢 | Relayer answers, and serves this chain and this pool | both networks |
| 🟢 | Relayer payout address unchanged | matches the recorded baseline, both networks |
| 🟢 | Relayer's own float figure agrees with the chain | agrees, both networks |
| 🟢 | Every alarm actually fires | governance and turnstile against simulated drift; all 7 relayer alarms against [`mutants.mjs`](mutants.mjs) |
| 🟡 | Mainnet relayer float | 0.0402 ETH, about **358 spends**. Above the alert floor, inside the watch band |
| 🟡 | Nothing schedules the watcher | run by hand; a VPS timer needs a deploy |
| 🟡 | No notification channel | an alarm nobody is told about is a log entry |

**The pool has no pause.** If this alarms, the levers are: stop the relayers,
banner the app, tell people to withdraw self-paid. That is the whole playbook and
it is written out below.

The last two 🟡 rows are the same gap seen from two sides — every check is built
and proven, and nothing runs them on a clock or tells anyone when they speak.

```
npm run watch                                  # every network with a pool
npm run watch -- --network robinhood-mainnet
npm run watch -- --update                      # re-record the baseline from chain
npm run test:watch-mutants                     # prove the relayer alarms still fire
```

**`--update` on its own had never worked.** `argv.indexOf("--network")` returns
`-1` when the flag is absent, and `argv[-1 + 1]` is `argv[0]`, so the first
argument of any run was silently read as a network name: the exact command this
file documented died on `No network named --update`. Recorded as **I-01** below,
fixed, and it is the reason the relayer baseline could be captured at all. It
failed loudly rather than quietly, which is the only reason it cost minutes.

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

## The relayer

Gasless has been the default door on every spend surface in both clients since
2026-07-28. That makes the relayer's balance a liveness dependency for most of
the product, and it is the one dependency that **empties silently**: nothing
about a quote that succeeds says the wallet behind it is nearly out, and when it
does run dry the failure arrives for everyone at once.

### Measured from the chain, not from the daemon

This file previously proposed the check as "one HTTP GET", because the daemon
already reports `floatWei` and `spendsLeft` in every quote. That build was
rejected. **A control that asks the thing it watches whether it is well is not a
control** — a daemon that is compromised, misconfigured, or simply running an
older build reports whatever that build reports.

So the measurement is `getBalance()` against the payout address the quote
advertises, read from the chain. The daemon's own figure is still read, and used
only as a cross-check: the shipped daemon derives both numbers from the same
account it advertises, so the two can only disagree if the box is not running
the code we think it is, which this project has already been bitten by once. The
cross-check alarms only when the daemon claims **more** than the chain shows, and
only past five spends of tolerance, because the relayer legitimately spends gas
between the two reads.

### The float is counted in spends, not in ether

Ether alone answers nothing without the gas price beside it. The divisor is the
relayer's own `feeWei` from its own quote, so this watcher holds **no copy of
`GAS_PER_SPEND`** to drift out of step with `src/relayer/server.ts`. That fee
carries the relayer's margin, which makes the count slightly conservative, and
conservative is the correct direction for a low-fuel warning.

| Band | Spends left | What it means |
|---|---|---|
| alert | under 100 | roughly half an hour of headroom at the busiest rate this pool has ever run, weeks at an ordinary one |
| watch | under 500 | noticed on a routine run rather than during an incident |
| ok | 500 and up | |

The floor is set from the airdrop's peak of a claim every 27 seconds, which is
about 130 spends an hour. It is deliberately far above the daemon's own
`LOW_FLOAT_SPENDS = 20`, which only ever writes a line to a console nobody reads.

A private trade burns roughly **two spends' worth** of gas, so trades stop before
sends do.

### Proven able to fire

[`mutants.mjs`](mutants.mjs) stands a stub relayer up on loopback, points
`src/networks.ts` at it, and makes it lie one way per mutant. **7 of 7 caught**,
2026-07-31:

| Mutant | Alarm |
|---|---|
| `relay-down` | `RELAYER NOT ANSWERING` |
| `wrong-chain` | `RELAYER ON THE WRONG CHAIN` |
| `wrong-pool` | `RELAYER ON THE WRONG POOL` |
| `payout-drift` | `RELAYER PAYOUT ADDRESS CHANGED` |
| `zero-fee` | `RELAYER QUOTES A ZERO FEE` |
| `float-low` | `RELAYER FLOAT LOW` |
| `over-report` | `RELAYER OVER-REPORTS ITS FLOAT` |

It runs a control first and refuses to report anything if the unmutated watcher
already alarms. The source file is restored in a `finally` **and** on SIGINT,
SIGTERM and SIGHUP, with a byte-for-byte check at the end, because a killed
harness that leaves the network definition pointed at loopback is worse than one
that never ran. That is not hypothetical: the first version used `spawnSync`,
whose blocked event loop starved the stub server living in the same process, and
the timeout that followed left the file mutated.

## Findings

| ID | Severity | Status | What |
|---|---|---|---|
| I-01 | Informational | **Fixed** | `--network` parsing read `argv[0]` whenever the flag was absent, so `--update` on its own — the form this file and the script's own header documented — exited 2 with `No network named --update`. The baseline could only ever be refreshed by naming a network. Now parsed properly, and a `--network` with no value after it is a usage error instead of a silent full-fleet run |

Impact is on the operator, not on deposited value: the broken path fails closed
and loudly. It is recorded because a watcher whose documented refresh command
does not run is a watcher whose baseline goes stale without anyone deciding it
should.

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

### `RELAYER FLOAT LOW` · `RELAYER NOT ANSWERING`

**Availability, not theft.** Nobody's deposit is at risk and nothing needs to be
stopped. Both clients already fall back to self-paid when the relayer will not
answer, so the pool stays fully usable by anyone holding gas.

1. Top the float up. The address is in `pool-baseline.json` under `relayer`.
2. If it will not answer, check the unit on the VPS before assuming the worst.
   Both relayers are `systemd` units beside each other.
3. Tell people it is gasless that is down, not the protocol. The distinction is
   worth making out loud, because the two look identical from a failed send.

### `RELAYER PAYOUT ADDRESS CHANGED` · `RELAYER OVER-REPORTS ITS FLOAT` · `RELAYER ON THE WRONG CHAIN` · `RELAYER ON THE WRONG POOL`

**Treat the daemon as untrusted until you know why.** These four all say the same
thing in different words: the relayer is not the one the baseline recorded, or it
is not running the build we think it is.

Nothing here can move a deposit — the proof binds `recipient`, `relayer` and
`fee`, so a relayer that alters any of them produces a spend that fails to
verify, and a relayer on the wrong chain or pool simply cannot submit. The
exposure is the **fees**, which flow to whatever address the daemon advertises,
and the availability of the gasless path.

1. Was it a rotation you performed? If so, `npm run watch -- --update` and commit.
2. If not, stop the unit and check what is deployed on the box before restarting
   it. `install.sh`-style redeploys have shipped stale running code here before.
3. Users are unaffected either way: point them at self-paid while it is out.

### `owner CHANGED`

Ownership moved. If it was not you, every other check in the run is
untrustworthy, because whoever holds the key can propose a swap at will. Same
response as an undeliberate pending swap, minus the option to cancel.

## Not yet done

- **Nothing runs this on a schedule.** It is a one-shot check built to be
  cron- or timer-friendly, and it has only ever run by hand. Putting it on the
  VPS beside the relayers is the obvious next step and needs a deploy.
- **No notification channel.** Exit code 1 tells a shell, not a person. This is
  now the largest remaining gap in this tree: every check that matters is built
  and every alarm is proven to fire, and all of it is still addressed to nobody.
- **The float alarm cannot refill anything.** `rebalance.ts` sweeps ERC-20 fees
  back to gas, but the float only truly refills from outside. A watcher that
  says "top it up" still needs a human holding ether.
- **No `Tenderly` or `Forta` alert on turnstile divergence.** A second,
  independent pair of eyes on the same question, from infrastructure we do not
  run. Still worth having, still needs an account.
