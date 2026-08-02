# Audits

The index of every audit artifact in this repository, and the vocabulary they
share. The rule this directory enforces: a security claim without an artifact
behind it does not ship — not on the website, not in a tweet. Reports are
published whether or not the findings are flattering; an audit page that only
shows clean results is not evidence of anything.

## Status at a glance

| | Area | Where it stands | Report |
|---|---|---|---|
| 🟢 | Pool accounting | Six invariants held across 245,760 randomised calls. Turnstile exact to the wei on every token that ever entered, on both live pools | [invariant/](invariant/README.md) · [monitoring/](monitoring/README.md) |
| 🟢 | Circuit constraints | Every constraint proven load-bearing: 17 deleted one at a time, 17 caught. Public inputs match the pool on all 14 of `spend` and 6 of `shield` | [circuits/](circuits/README.md) |
| 🟢 | Deployed code is the published code | All three contracts verified on Blockscout; the pool is byte-identical to a build from HEAD, and the adapter's deployed commit is pinned by bytecode comparison | [static/](static/README.md) |
| 🟢 | Contracts, static | Neither scanner found a path to deposited funds. Every finding triaged against source, and a gate on every push now fails on anything untriaged | [static/](static/README.md) |
| 🟢 | Test integrity | Three mutation harnesses, so a test or an alarm that stopped constraining anything would show up rather than stay green | [invariant/](invariant/README.md) · [circuits/](circuits/README.md) · [monitoring/](monitoring/README.md) |
| 🟢 | Continuous integration | 7 jobs in the cli and 3 in the app, green since the first run, every action SHA-pinned. All four mutation harnesses run on every push | [ci/](ci/README.md) |
| 🟢 | Supply chain | Nothing in either tree reaches a user's keys: every advisory read and rebutted with bundle evidence. One install script in what a user installs, and the CLI is proven to work without it. **Both repositories** gated on every push against their own baseline, by the same gate, kept from drifting apart by a recorded hash | [supplychain/](supplychain/README.md) |
| 🟢 | Alarms reach a person | The watch now tells somebody: 15 delivery, suppression and refusal cases against a stub sink, 12 defences deleted one at a time, 12 caught. **Live on a 15-minute timer since 2026-08-01** | [monitoring/](monitoring/README.md) |
| 🟢 | Somebody is watching, on a clock | Mainnet checked every 15 minutes from the VPS since 2026-08-01, alarms delivered to a private channel, daily heartbeat so a dead timer is noticeable | [monitoring/](monitoring/README.md) |
| 🟢 | Gasless relayer, from outside | Answers, serves the right chain and pool, payout address matches the baseline, and its own float figure agrees with the chain. All 7 alarms proven to fire | [monitoring/](monitoring/README.md) |
| 🟢 | Relayer daemon, from inside | The only component holding a funded key and answering the open internet, and the last one with no test. Six findings, all fixed and **live on both relayers since 2026-08-01**; nothing reaches deposited value. 8 defences deleted one at a time, 8 caught | [relayer/](relayer/README.md) |
| 🟢 | Two clients, one pool | The browser port and the CLI compute the same numbers: field, note, cipher, key and Merkle parity, swept over edge vectors, gated on every push in the app | [parity](https://github.com/Cowl-Protocol/app/blob/main/audits/parity/README.md) |
| 🟢 | App and CLI code | CodeQL `security-extended` read on both repositories: 4 findings, 1 fixed, 3 rebutted with reasoning. Nothing in proving, note handling, key derivation or the wire format | [codeql/](codeql/README.md) |
| 🟢 | Governance | Pool is not a proxy and cannot be edited. Its one lever — a 7-day timelocked verifier swap — is held by a **2-of-3 Safe** since 2026-08-02, on both pools. One stolen key reaches nothing, and cannot renounce the hatch either | [static/](static/README.md) · [deploy/multisig/](../deploy/multisig/README.md) |
| 🟡 | Paid disclosure | Scope, severity mapping, known issues and platform are written and ready to launch; no vault is funded and the three numbers are undecided | [bounty/](bounty/README.md) |
| 🟡 | Trade adapter | L-01 and L-02 **fixed, deployed and verified 2026-08-02** — new adapter on both chains, proven by a real private trade on testnet first. CLI 0.6.15 and both relayers carry it, proven by a gasless trade through the new adapter. Yellow for one leg: the browser client still ships the old address until the app is deployed. The redeploy itself uncovered [R-07](relayer/README.md) | [static/](static/README.md) |
| 🟡 | Circuit residuals | Two properties the circuits do not carry alone. Both are held by the pool or need a token that does not exist. Closing either costs a timelocked verifier swap | [circuits/](circuits/README.md) |
| 🟡 | Relayer fee pricing | The fee a relayer demands in an ERC-20 comes from a venue quote, and a bound on how far the tiers may disagree is not a proof that any of them is honest. An attacker can now deny a token, never underpay for one | [relayer/](relayer/README.md) |

**No 🔴 anywhere today.**

### What the colours mean

| | Meaning |
|---|---|
| 🟢 | **Clean.** Checked, holds, nothing outstanding |
| 🟡 | **Watch.** Understood and deliberately not closed, or closed in source but not yet on chain. The reason and the residual are both written down |
| 🔴 | **Act.** Reaches deposited funds, or is unresolved above Informational and nobody has decided what to do |

The scale is about what is left standing, not about how a finding was scored.
A Medium that was fully closed is 🟢; an Informational deliberately left open is
🟡. Severity is the Impact × Likelihood matrix further down and stays separate.

## Progress

Phases and steps follow the audit plan this work is run from. A step is checked
only when its artifact is in this tree. Results live in the linked report, never
in this table.

**Execution order is not plan order, on purpose.** Phase 1's scanners and Phase
3's watcher ran first, because they are the two that protect the balance already
in the pool. The plan says as much about Phase 3 and the same reasoning applied
to the scanners.

### Phase 0 — foundation

| | Step | Artifact |
|---|---|---|
| ☑ | GitHub Actions workflow (cli, app) | [ci/](ci/README.md) |
| ☑ | Circuit adversarial harness | [circuits/](circuits/README.md) |
| ☑ | Foundry invariant suite | [invariant/](invariant/README.md) |

**Phase 0 is complete.**

The plan calls the middle step "Noir fuzz harnesses" and describes it as giving
the existing `#[test]` functions arguments so `nargo` fuzzes them. **That is not
sufficient and the step was deliberately renamed.** Fuzzing the inputs of `main`
only demonstrates that valid witnesses are accepted. The class of bug that
empties a pool is the opposite one, a circuit that accepts a witness it should
reject, and reaching it needs adversarial witness generators and `should_fail`
tests. The reasoning and what was built instead are in
[circuits/](circuits/README.md).

`gh`, `act` and `actionlint` are all absent from the build machine, so workflows
are written locally, every command in them is proven locally, and the workflows
themselves are first exercised by the push that lands them. Both went green on
that first run.

### Phase 1 — free tooling

| | Step | Artifact |
|---|---|---|
| ☑ | Slither, every finding triaged against source | [static/](static/README.md) |
| ☑ | Aderyn, same | [static/](static/README.md) |
| ☑ | CodeQL (app, cli) | [codeql/](codeql/README.md) |
| ☑ | OpenSSF Scorecard | [supplychain/](supplychain/README.md) |
| ☑ | Dependabot | [supplychain/](supplychain/README.md) |
| ☐ | Socket | a GitHub App, so only the account owner can add it |
| ☑ | Scanners wired into CI, build fails on anything untriaged | [static/](static/README.md) |

**CodeQL was read on 2026-07-31 and is now ticked.** `gh` and the CodeQL CLI are
both absent from the build machine, so rather than wait for access to the
Security tab, the 2.26.2 bundle was downloaded, checksum-verified and run
locally with the same `security-extended` suite the workflows ask for. Four
findings, one fixed, three rebutted: [codeql/](codeql/README.md). The hosted run
will still differ, and the report says how.

The paragraph below is kept because it is still true of the **workflow**, and it
is what the hosted alerts will need. Both repositories have
`.github/workflows/codeql.yml` as of 2026-07-29, pinned, scoped to
`security-events: write` in its own file so `ci.yml` stays read-only, running on
every push and weekly so new queries reach unchanged code. But it **reports, it
does not gate** — the CodeQL action has no fail-on-finding switch, and there is no
baseline behind it the way there is for slither and aderyn, because writing one
before ever seeing the output would be guessing. The rule at the top of this
section applies: a step is ticked when its artifact is here. What completes it is
reading the first run and writing the verdicts down.

**Scorecard was ticked, then unticked, then ticked again on 2026-07-31**, and
the middle step was the right instinct. A workflow that has never run produces no
score, and a score nobody has read is not an artifact — the same rule that keeps
CodeQL honest. What settled it was running Scorecard 5.5.0 locally against both
repositories and writing the per-check verdicts down, which is the artifact.
cli **8.9**, app **8.0**. The hosted run will differ because it also scores the
GitHub account and its history, and that is said plainly in the report.

**The gate is stricter than the plan asked for.** The plan says the build should
fail on any high-severity finding. That would be the wrong line here: tool
severity is not report severity, and the two findings both scanners rank highest
(`arbitrary-send-eth`) were read against source and rebutted. Meanwhile a fresh
Informational nobody has looked at would sail through.

So the gate fails on anything **untriaged** instead, at any severity, measured
against a recorded baseline of the 23 accepted fingerprints. A new finding is
red until someone reads it and writes a verdict. That is the plan's own standard
— a scanner nobody is forced to read is not a control — applied to the thing it
was actually about.

### Phase 2 — proof that the published package is the published source

| | Step | Artifact |
|---|---|---|
| ☐ | npm provenance on `@cowlprotocol/cli` | — |

**Blocked on a decision, not on work.** Provenance requires publishing from CI,
which replaces the manual OTP release ritual. That is a choice about how
releases happen, and it belongs to whoever holds the npm account.

### Phase 3 — watch the money that is already in

| | Step | Artifact |
|---|---|---|
| ☑ | State watcher, recorded baseline, response playbook | [monitoring/](monitoring/README.md) |
| ☑ | Relayer float check | [monitoring/](monitoring/README.md) |
| ☑ | Notification channel | [monitoring/](monitoring/README.md) |
| ☑ | Scheduled runs on the VPS | **live since 2026-08-01** — [deploy/watch/](../deploy/watch/README.md) |
| ☐ | Tenderly or Forta alert on turnstile divergence | — |

`npm run watch` is written, proven to alarm, and run by hand. It covers the
relayer as well as the pool, and **measures the float from the chain rather than
from the daemon's own report** — a control that asks the thing it watches whether
it is well is not a control.

**The channel this section called the next gap is closed.** `npm run watch:notify`
runs the same check and tells a person, with a fourth exit code — **3, nobody was
told** — because a result that reached no one is worth what a check that never ran
is worth. What it refuses is as much of the design as what it sends: no plaintext
sink, no redirects, no group-readable secret, and the URL never in a log line,
since a Discord or Telegram webhook is secret in its *path*. It stays quiet on a
clean run and suppresses a repeat of the same alarms, which is what decides
whether anyone still reads the channel in a month, and it says `RECOVERED` out
loud because going quiet after an alert is indistinguishable from the alert
clearing.

**And the clock is running.** Both timers went live on the VPS on 2026-08-01:
the mainnet check every 15 minutes, and a daily heartbeat. The first automated
run passed and, correctly, **said nothing** — `not notifying: nothing to say` is
the line that decides whether anyone still reads the channel in a month.

Pinned to mainnet on purpose. Left alone the watcher checks every network with a
pool, and the testnet one holds nothing: a flaky testnet RPC would page somebody
for work nobody has to do.

The residual is named where it belongs — a timer that stops firing sends nothing,
and nothing is what a healthy quiet run looks like too. The heartbeat is the
cheap half of that answer and an external dead-man's switch is the rest.

### Phase 4 — human eyes

| | Step | Artifact |
|---|---|---|
| ☑ | Program scope, severity mapping, known issues, platform choice | [bounty/](bounty/README.md) |
| ☐ | Hats Finance vault funded with $COWL | needs the amount |
| ☐ | Aztec grant application for a circuit review | — |
| ☐ | Immunefi, Sherlock, CodeHawks or Code4rena | — |
| ☐ | Firm engagement for the circuits | — |

Hats is the natural first move: the vault funds from the creator-fee stash
rather than from cash, and launching does not wait for a slot. The open question
is the amount.

**The document all four rows needed is written.** [bounty/](bounty/README.md)
carries the asset table with addresses, the severity mapping — the internal
Impact × Likelihood matrix governs, not the platform's generic table, or the same
finding grades two ways depending on where it was reported — every 🟡 in this
tree declared as a known issue, and the platform comparison. Three numbers are
left and all three belong to whoever holds the creator-fee stash: vault size, the
critical percentage and its cap, and the floor.

Two things in there are worth reading before the vault is funded rather than
after. **A bounty here is not buying a patch.** The pool is immutable, so a
finding in `ShieldedPool.sol` cannot be fixed in place — the reward is priced
against the difference between hearing it from a researcher and hearing it from a
drained pool, which is all of `pooledValue`. And **the adapter's deployed
bytecode predates the L-01/L-02 fixes** — which is now settled rather than open:
the deployed build is declared the in-scope artifact, its commit pinned by
bytecode comparison and verified on the explorer, and the fixes ride the next
redeploy that earns one on its own merits.

### Phase 5 — formal verification

| | Step | Artifact |
|---|---|---|
| ☐ | Certora Prover against the pool invariants | — |

The six invariants are already written in the shape a specification wants, which
is most of the setup cost. It still belongs after the cheap work.

### Beyond the plan

| | Step | Artifact |
|---|---|---|
| ☑ | Mutation harness proving the invariant suite can fail | [invariant/](invariant/README.md) |
| ☑ | Mutation harness proving the relayer alarms can fire | [monitoring/](monitoring/README.md) |
| ☑ | Dependency gate: fails on a new install script or an untriaged advisory | [supplychain/](supplychain/README.md) |
| ☑ | Adversarial harness against the relayer daemon itself | [relayer/](relayer/README.md) |
| ☑ | A lock so two mutation harnesses cannot restore each other's mutants | [lib/mutation-lock.mjs](lib/mutation-lock.mjs) |
| ☑ | Runbook for moving the escape hatch to a 2-of-3 Safe, owners verified | [deploy/multisig/](../deploy/multisig/README.md) |
| ☑ | Differential sweep of the browser port against this one | [parity](https://github.com/Cowl-Protocol/app/blob/main/audits/parity/README.md) |
| ☑ | Mutation harness proving the notification channel can fail | [monitoring/](monitoring/README.md) |

Not in the plan, added because a green suite proves nothing on its own:
an invariant no mutation can violate is testing nothing. Six mutations, one per
pool defence, each caught by the invariant that names it.

**The cross-check is the one thing the plan named and nobody had extended.** It
calls `crosscheck.mts` the strongest asset in the repository and says extending
its coverage is the highest-value circuit work that costs nothing. It drew one
random sample per property, and the disagreements worth finding do not live at a
random point — they live at zero, at one, at the field boundary and at the limb
carry. Every property now sweeps an edge set plus 256 random vectors, the Merkle
tree went from no cross-check at all to three, and the whole thing runs on every
push to the app against both checkouts. What an agreement is worth is stated per
module rather than implied: [parity](https://github.com/Cowl-Protocol/app/blob/main/audits/parity/README.md).

**The relayer daemon is beyond the plan too, and it is the gap that reading the
plan found.** The plan ranks the relayer fourth by what it costs when it breaks
and scopes it as "availability and overcharge, not theft", which is right. What
nothing in this tree had done is read the process itself: it holds a funded key,
listens on a public port, and signs on the strength of a payload written by an
anonymous caller, and it was the only component in the protocol with no test and
no report. [relayer/](relayer/README.md).

## Re-verified at HEAD

A status board that is green because each report was green **when it was
written** is a weaker claim than it looks. Everything in this tree was re-run on
**2026-08-01** at `3a57081`, on one machine, in one pass.

| Harness | Result |
|---|---|
| `forge test` | 78 passed |
| `test:invariant` | 10 passed across 3 suites |
| `test:mutants` | 6/6 caught |
| `test:circuits` | 32 passed — notes 3, shield 6, transfer 23 |
| `test:circuit-mutants` | 17/17 caught, circuits restored |
| `test:publicinputs` | circuit and pool agree on all 14 of `spend` and 6 of `shield` |
| `test:relayer` | 8/8 held |
| `test:relayer-mutants` | 8/8 caught, sources restored byte for byte |
| `test:notify` | 15 cases, 12/12 mutants caught |
| `test:watch-mutants` | 7/7 caught |
| `test:scanners` | no new findings — 23 fingerprints, 32 instances, all triaged |
| `test:supplychain` | 1 advisory, all triaged, nothing new |
| `npm run watch` | all clear, both pools, turnstile exact |
| app `crosscheck` (full) | all passed, including the mainnet replay — 368 leaves rebuilding the chain's root — and a real shield proof, 7,232 bytes in 939 ms |
| app `test:offline` | all green |
| `typecheck`, both repositories | clean |

The pass also found something, which is the point of running it rather than
trusting the board.

### The mutation harnesses could corrupt each other

Four harnesses here prove their suites can fail by editing first-party source
**in place** and restoring it after. Each is careful about its own restore, on
signals as well as on exit. **None of them was careful about the other three.**

It surfaced in the harmless direction first: `npm run test:circuits` was started
while the circuit mutant harness was mid-run, and the clean suite reported two
failures that were not real. The harmful direction is two *mutating* harnesses
overlapping, because the second one's "original" is the first one's mutant — and
its restore then writes a weakened file back **as the baseline**. A circuit
missing one constraint, restored as though it were the source, is precisely the
quiet failure this tree exists to catch.

They now share a lock: [`lib/mutation-lock.mjs`](lib/mutation-lock.mjs), a
directory rather than a file because `mkdir` is atomic in node and in bash, and
the invariant harness is a shell script. Refusing is the right behaviour rather
than queueing — these runs take minutes and a developer who started the wrong
one wants to be told. A lock older than an hour is taken over, so a crashed run
cannot block the tree forever.

All four were confirmed to refuse while it is held, and all four were re-run
with it wired in: 17/17, 8/8, 6/6 and 7/7, every source restored.

`test:notify` deliberately does **not** take it. It is the one harness that
mutates a *copy* rather than the original, which is why it has no restore to get
wrong, and why it cannot corrupt anything another harness is holding.

## Reports

| | Date | Work | Scope | Audited commit | Outcome | Report |
|---|---|---|---|---|---|---|
| 🟡 | 2026-07-28 | Static analysis — slither 0.11.5 + aderyn 0.6.8, every finding triaged against source | `ShieldedPool.sol`, `CowlTradeAdapter.sol` | `1cbb48a` | No path to deposited funds. 1 Medium mitigated, 2 Low fixed in source, 3 Informational acknowledged | [static/](static/README.md) |
| 🟡 | 2026-07-28 | Governance & turnstile monitoring — state watcher, recorded baseline, response playbook | Both live pools (mainnet 4663, testnet 46630) | live chain state | Turnstile exact to the wei on every token that entered through `shield()`; no pending verifier swaps; `npm run watch` | [monitoring/](monitoring/README.md) |
| 🟢 | 2026-07-29 | Invariant suite — six pool properties under randomised call sequences, verifier stubbed to accept everything | `ShieldedPool.sol` | `5eb31a8` | All six held across 245,760 calls. Suite proven able to fail: 6/6 mutations caught. 2 Informational, both unreachable through a sound verifier | [invariant/](invariant/README.md) |
| 🟢 | 2026-07-29 | Continuous integration — build, typecheck, contracts, circuits and the mutation harness on every push, both repos | `Cowl-Protocol/cli`, `Cowl-Protocol/app` | `cf9fdb6`, `b600bbc` | 5 jobs, all green on the first real run. Every action SHA-pinned, no gate touching live infrastructure. 1 Informational (the app's lint script has never worked) | [ci/](ci/README.md) |
| 🟢 | 2026-07-29 | Circuit adversarial harness — witnesses valid in every respect but one, aimed at each constraint in turn, plus the public-input binding against the pool | `transfer`, `shield`, `notes` | `26511b2` | Every constraint proven load-bearing: 17 deleted one at a time, 17 caught. No missing constraint found; circuits unchanged. 2 Informational | [circuits/](circuits/README.md) |
| 🟢 | 2026-07-31 | Relayer watch — liveness, chain and pool binding, payout drift, float measured from chain, self-report cross-check | `relay.cowlprotocol.com` (mainnet + testnet), both payout wallets | live chain state | Both relayers correct and answering; mainnet float 0.0402 ETH, about 358 spends, inside the watch band. All 7 alarms proven to fire. 1 Informational fixed (`--update` had never worked) | [monitoring/](monitoring/README.md) |
| 🟢 | 2026-07-31 | Supply chain — install scripts, advisories, and what the shipped bundle actually contains | `Cowl-Protocol/cli` 43 production packages, `Cowl-Protocol/app` 929 | `e6d254a`, app `31249e9` | No path to a user's keys. 37 advisories read and rebutted with bundle evidence; 1 install script reaches users and the CLI runs without it. 3 Informational/Low, all acknowledged or mitigated | [supplychain/](supplychain/README.md) |
| 🟢 | 2026-08-01 | Dependency gate for the app — its own baseline over its own lockfile, and a drift guard between the two copies | `Cowl-Protocol/app` 929 packages | app `0c2c364` | 8 install scripts and 27 advisories, each with a written verdict; none reachable, with bundle evidence over 225 chunks and controls proving the sweep. Gate proven to fail on all three drift classes | [supplychain/](supplychain/README.md) |
| 🟢 | 2026-08-01 | Adapter ERC-20 input leg — the two `trade()` branches no proof fixture reaches, and the surplus refund L-01 exists for | `CowlTradeAdapter.sol` | `ce11804` | 4 tests added, 78 total. Both mutations caught: dropping the return check and removing the refund each fail a test that names them. The recorded gap was a missing test, not a missing fixture, and the report says so | [static/](static/README.md) |
| 🟡 | 2026-08-01 | Relayer daemon — adversarial cases against the real process over a stub chain, plus the mutants that prove each case bites | `src/relayer/{server,client,rebalance}.ts` | `90836c5` | 6 findings, all fixed: 1 Medium (one dust pool set the fee for a whole token), 2 Low (an endpoint hiccup killed the daemon; 6 uncapped RPC calls per anonymous request), 3 Informational. 8/8 mutants caught. One residual named. Deployed to both relayers the same day, proven running rather than merely installed | [relayer/](relayer/README.md) |
| 🟢 | 2026-08-02 | Escape hatch moved to a 2-of-3 Safe, mainnet | pool `0x6f98666e…6a3E`, Safe `0x708c36A9…54f3` | live chain state | Rehearsed end to end on testnet first, then the Safe was made to execute a no-op on mainnet before it was trusted with anything — an address that can receive the hatch but not sign takes it away permanently. Deployer can no longer propose, execute or renounce | [deploy/multisig/](../deploy/multisig/README.md) |
| 🟢 | 2026-08-02 | Deployed bytecode against published source, then verification on the explorer | `ShieldedPool` both chains, `CowlTradeAdapter` mainnet | pool `37bf195`, adapter `8b1c58f~1` | The pool is a reproducible build — 13,427 bytes identical to a local build, solc 0.8.35, no optimizer. The adapter's deployed commit pinned by bytecode diff: it differs from `8b1c58f~1` only where the `immutable` pool and WETH addresses are baked in. All three verified | [static/](static/README.md) |
| 🟢 | 2026-08-01 | Watch on a clock — two systemd timers on the VPS, mainnet only, alarms to a private channel | `deploy/watch/`, VPS | live infrastructure | First automated run read the pool, found nothing and said nothing. Heartbeat daily so a dead timer is noticeable. Relayer untouched: separate user, directories and units | [monitoring/](monitoring/README.md) |
| 🟢 | 2026-08-01 | Multisig rehearsal on testnet — Safe deployed, pool handed over, hatch pulled and put back | testnet pool, Safe `0x708c36A9…54f3` | live chain state | 2-of-3 Safe operates the escape hatch: a verifier swap proposed and cancelled with two signatures. The governance alarms fired against it cold, reading 168.0 hours off the chain | [deploy/multisig/](../deploy/multisig/README.md) |
| 🟢 | 2026-08-01 | Cross-client parity — the browser port against this one, swept, plus the mutations that prove the sweeps bite | `app/lib/shielded/*`, `cli/src/shielded/*` | app `69787e5` | Field, note, cipher, key and Merkle parity hold across edge and random vectors. Merkle had no cross-check before and now has three, including the insertion witness's double walk. 4 mutations, 4 caught; a 5th survived correctly and is recorded. Now a push gate | [parity](https://github.com/Cowl-Protocol/app/blob/main/audits/parity/README.md) |
| 🟢 | 2026-08-01 | Notification channel — delivery, suppression and refusal against a stub sink, plus the mutants that prove each case bites | `scripts/notify.mjs`, `deploy/watch/` | working tree at `45399ff` | 15 cases pass, 12/12 mutants caught. A fourth exit code for "nobody was told"; plaintext sinks, redirects and group-readable secrets all refused. Scheduling units written; deployed to the VPS the next day | [monitoring/](monitoring/README.md) |
| 🟢 | 2026-07-31 | CodeQL `security-extended`, run locally at 2.26.2 after checksum verification | `Cowl-Protocol/cli` 43 files, `Cowl-Protocol/app` 76 files | working tree at `e6d254a` + uncommitted | 4 findings. 1 real and fixed (a check-then-use race in code from the same session, fix verified by re-running); 2 configurable-endpoint reports with no privilege boundary; 1 false positive on a dedicated worker | [codeql/](codeql/README.md) |

## Conventions

Every report in this tree uses the same words, so a severity in one phase means
the same thing in another.

**Severity** — Impact × Likelihood:

| | Likelihood High | Medium | Low |
|---|---|---|---|
| **Impact High** | Critical | High | Medium |
| **Impact Medium** | High | Medium | Low |
| **Impact Low** | Medium | Low | Low |

Impact is measured against deposited value first, availability second.
**Informational** is anything worth recording that does not meet the matrix.

**Status** — exactly one of:

- **Fixed in `<commit>`** — with the test that pins it, or a stated reason none does
- **Mitigated** — reduced but not removed, and what remains is named
- **Acknowledged** — understood and deliberately not fixed, with the reasoning written down
- **Open** — nobody has decided anything yet

**IDs** — `[C|H|M|L|I]-NN`, unique within a report, stable once published.

**Tool severities are not report severities.** What slither calls High and
aderyn calls H- stays in the raw output. A finding gets its severity here from
someone reading the source — or it gets a rebuttal, which is recorded too.

**External reports** land as `<YYYY-MM-DD>-<auditor>/` beside the phase
directories, with the audited commit named inside. Fix commits are linked from
each finding, so a reader can trace finding to fix without trusting the summary.

## Reproducing any of it

```
npm run test:invariant                 # the six pool invariants
npm run test:mutants                   # proves the invariant suite can fail
npm run test:circuits                  # notes, shield and transfer
npm run test:circuit-mutants           # proves the circuit tests can fail
npm run test:publicinputs              # circuit public inputs vs the pool's
npm run test:relayer                   # the daemon under attack, over a stub chain
npm run test:relayer-mutants           # proves each relayer case can fail
npm run test:notify                    # the notification channel, and its mutants
npm run test:scanners                  # fails on any static finding nobody triaged
npm run test:relay -- --static         # the half of the relay check CI runs
./audits/static/scan.sh                # regenerates both scanner reports
cd contracts && forge test             # the whole contract suite
```

Two of these read live infrastructure and are deliberately kept out of CI, so
they only ever run when someone runs them:

```
npm run watch                          # governance + turnstile vs baseline
npm run watch:notify                   # the same, and tell somebody about it
npm run test:relay                     # adds the live half: are the daemons current
```
