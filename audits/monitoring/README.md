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
| 🟢 | Every alarm reaches a person | 15 cases against a stub sink, 12 defences deleted one at a time, 12 caught |
| 🟡 | Mainnet relayer float | 0.0388 ETH, about **337 spends** on 2026-08-01. Above the alert floor, inside the watch band |
| 🟡 | Nothing schedules the watcher | units written and proven locally; installing them is a deploy |

**The pool has no pause.** If this alarms, the levers are: stop the relayers,
banner the app, tell people to withdraw self-paid. That is the whole playbook and
it is written out below.

**The channel half of that gap is closed.** `scripts/notify.mjs` takes the
watcher's exit code and tells somebody, and
[`notify-mutants.mjs`](notify-mutants.mjs) proves it — including that it stays
quiet when there is nothing to say, which is the property that decides whether
anyone still reads the channel in a month. The clock half is written as systemd
units in [`../../deploy/watch/`](../../deploy/watch/README.md) and **not
installed**: putting them on the VPS is a deploy.

```
npm run watch                                  # every network with a pool
npm run watch -- --network robinhood-mainnet
npm run watch -- --update                      # re-record the baseline from chain
npm run test:watch-mutants                     # prove the relayer alarms still fire

npm run watch:notify                           # the same check, then tell somebody
npm run watch:notify -- --dry-run --heartbeat  # print what would be sent, send nothing
npm run test:notify                            # the channel's cases, then its mutants
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

## The notification channel

Every alarm above was proven able to fire, and every one of them fired into a
shell. This is the part that makes one arrive at a person.

[`../../scripts/notify.mjs`](../../scripts/notify.mjs) runs the watcher as a
child, reads its exit code, and posts to a webhook. It is a **wrapper rather
than a flag**, and deliberately: `watch-pool.mjs` holds seven alarms that
[`mutants.mjs`](mutants.mjs) pins, and adding outbound HTTP to the one component
whose job is to be trustworthy would widen its surface and put every future
delivery change in a file whose alarms are already nailed down. The seam is
`--script`, an argument rather than a shell string, so the child is spawned with
an argv array and a path can never become a command.

### A fourth exit code

The watcher's three codes pass through — 0 clean, 1 something to look at, 2
could not check — and **3 means nobody was told**.

That code is the reason this file exists. A check whose result never reached a
person has the same operational value as a check that never ran, and from a
timer's perspective the two are indistinguishable unless something says so. A
delivery failure outranks the watcher's own verdict: exit 1 asserts that a human
has been told there is something to look at, and if the POST failed that is
precisely what did not happen.

### What it refuses

| Refusal | Why |
|---|---|
| plaintext sinks | the URL *is* the credential — Discord, Slack and Telegram all put the secret in the path. `https` required, loopback the only exception so the harness can stub a sink |
| redirects | a 3xx is a request to hand the same secret to a different host |
| group-readable secret files | `COWL_WATCH_WEBHOOK_FILE` must be `0600` or tighter, the same line `/etc/cowl-relayer/relayer.env` is held to on the same box |
| logging the URL | the sink is named by host and kind in every line it prints. A systemd journal is readable by more people than `/etc` is |

**What does leave the machine** is the watcher's output: pool address, token
balances, the relayer's payout address and float. All of it is already public on
chain and none of it is a key — but it is still a third party receiving it,
which is why the deploy notes call for a private channel rather than one anybody
can join.

### The two ways silence lies

A pending verifier swap alarms for seven days. At fifteen-minute ticks that is
672 identical messages, and the 673rd is the one nobody reads. So a repeat of the
same **digest** — the set of alarm labels, not the whole output, because balances
and leaf counts move between runs and would make every repeat look new — is
suppressed for `COWL_WATCH_REPEAT_MINUTES`. A digest that *changes* is always
sent: a second alarm arriving beside the first is new information.

The mirror of that is subtler. Going quiet after an alert is indistinguishable
from the alert clearing, so a clean run following an alerting one sends
`RECOVERED` whether or not anyone asked for heartbeats.

And the one this cannot solve alone: **it cannot notice its own absence.** A
timer that stops firing sends nothing, and nothing is what a healthy quiet run
looks like too. `--heartbeat` on a daily unit is the cheap half — a message whose
absence is the signal — and it only works if somebody notices it missing. The
complete answer is an external dead-man's switch, which needs an account, and it
is the same open row as Tenderly below.

### Proven able to speak, and to stay quiet

[`notify-mutants.mjs`](notify-mutants.mjs) stands a stub sink up on loopback and
hands the notifier fake watchers with scripted exit codes. The real watcher is
never run: what is under test is delivery, suppression and refusal, and pinning
those to live chain state would make the harness fail for reasons that have
nothing to do with the code it covers. **15 cases, 2026-08-01:**

| Case | What it holds |
|---|---|
| `alert-sent` | the alarm's own words survive the trip — a message saying "check the logs" is a log entry |
| `clean-silent` | a clean run says nothing at all |
| `heartbeat` | …unless asked |
| `unchecked-sent` | "could not check" is not "nothing wrong", and not silence either |
| `repeat-suppressed` | the same alarms inside the cooldown go out once |
| `digest-change` | a *different* alarm goes out immediately, cooldown or not |
| `recovery` | clearing is said out loud |
| `retry-then-fail` | a 502 does not eat an alert: 3 attempts, then exit 3 |
| `plaintext-refused` | nothing leaves over `http` |
| `redirect-refused` | the secret is not handed to a second host |
| `watcher-timeout` | a hung watcher is killed and the timeout is itself notified |
| `truncated` | an over-long body is cut to the sink's limit rather than rejected by it |
| `concurrent-run-skipped` | two runs sharing a state file is how a cooldown swallows an unseen alert |
| `stale-lock-taken` | …and a lock nothing can clear is a watcher that quietly stopped |
| `webhook-file-perms` | a group-readable secret is refused |

Then **12 defences deleted one at a time, 12 caught.** Each mutant re-runs the
one case that defence exists for, and a case that still passes without it was
never testing anything:

| Mutant | Case that breaks |
|---|---|
| `no-https-guard` | `plaintext-refused` |
| `no-perms-check` | `webhook-file-perms` |
| `no-cooldown` | `repeat-suppressed` |
| `digest-blind` | `digest-change` |
| `no-recovery` | `recovery` |
| `no-retry` | `retry-then-fail` |
| `no-kill` | `watcher-timeout` |
| `no-truncation` | `truncated` |
| `follows-redirects` | `redirect-refused` |
| `no-lock` | `concurrent-run-skipped` |
| `lock-never-stale` | `stale-lock-taken` |
| `silent-failure` | `retry-then-fail` |

`no-kill` is the one worth reading twice. It survived the first version of its
case, because a deadline that sets a flag without killing the child still
produces the right message and the right exit code — **eventually**, and
"eventually" is the entire bug: the unit stays active, the next tick stacks
behind it, and the alert arrives whenever the hung process feels like returning.
The case now measures elapsed time against a watcher that sleeps for twelve
seconds behind a one-second deadline, and only a run that actually killed it
comes back inside five.

The mutant is a **sibling copy** of `notify.mjs` rather than an edit of it. The
other two harnesses in this tree mutate their target in place and each carries a
paragraph about what happens when the restore does not run; a copy has no
restore to get wrong, and the original is never opened for writing.

The whole harness reaches no network and reads no chain, so it runs in CI beside
the relayer's, in about 35 seconds.

### Scheduling

Written and **not deployed**:
[`../../deploy/watch/`](../../deploy/watch/README.md) — two systemd timers, the
15-minute check and a daily heartbeat, with the reasoning for both cadences and
what the box needs. Installing them is a deploy and belongs to whoever holds the
VPS.

Two details in there are load-bearing rather than decorative. `Persistent=true`,
so a window missed to a reboot runs on the next boot instead of waiting out the
interval. And no `Restart=`, because the next tick is fifteen minutes away and a
retry storm against a rate-limited RPC is how a watcher becomes the outage it was
installed to catch.

The watcher gained one line for this: its esbuild scratch directory is now
`COWL_WATCH_TMP` if set. That lets the unit run under `ProtectSystem=strict`
with the checkout read-only to the process executing it, which it otherwise
could not, because the scratch directory was the one thing inside the repository
that needed to be writable.

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

- **Nothing runs this on a schedule yet.** The units exist and are proven
  locally; installing them on the VPS beside the relayers is a deploy, and this
  row closes when a timer is actually firing.
- **Nothing notices the watch itself dying.** The daily heartbeat is a message
  whose absence is the signal, and an absence is only a signal to somebody
  looking for it. An external dead-man's switch is the real answer and needs an
  account, same as the Tenderly row below.
- **No second sink.** One webhook is one point of failure: a Discord outage and
  a healthy quiet run look identical from here. Exit 3 catches the delivery
  failing at this end, which is the half that is checkable from here.
- **The float alarm cannot refill anything.** `rebalance.ts` sweeps ERC-20 fees
  back to gas, but the float only truly refills from outside. A watcher that
  says "top it up" still needs a human holding ether.
- **No `Tenderly` or `Forta` alert on turnstile divergence.** A second,
  independent pair of eyes on the same question, from infrastructure we do not
  run. Still worth having, still needs an account.
