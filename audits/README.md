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
| 🟢 | Contracts, static | Neither scanner found a path to deposited funds. Every finding triaged against source, and a gate on every push now fails on anything untriaged | [static/](static/README.md) |
| 🟢 | Test integrity | Three mutation harnesses, so a test or an alarm that stopped constraining anything would show up rather than stay green | [invariant/](invariant/README.md) · [circuits/](circuits/README.md) · [monitoring/](monitoring/README.md) |
| 🟢 | Continuous integration | 6 jobs in the cli plus the app's, green since the first run, every action SHA-pinned | [ci/](ci/README.md) |
| 🟢 | Supply chain | Nothing in either tree reaches a user's keys: 37 advisories read, none reachable, with bundle evidence. One install script in what a user installs, and the CLI is proven to work without it. Gated on every push against a baseline | [supplychain/](supplychain/README.md) |
| 🟢 | Gasless relayer | Answers, serves the right chain and pool, payout address matches the baseline, and its own float figure agrees with the chain. All 7 alarms proven to fire | [monitoring/](monitoring/README.md) |
| 🟢 | App and CLI code | CodeQL `security-extended` read on both repositories: 4 findings, 1 fixed, 3 rebutted with reasoning. Nothing in proving, note handling, key derivation or the wire format | [codeql/](codeql/README.md) |
| 🟡 | Governance | Pool is not a proxy and cannot be edited. The one lever is a 7-day timelocked verifier swap, held by a single deployer EOA. Watched, not yet scheduled, not yet a multisig | [static/](static/README.md) · [monitoring/](monitoring/README.md) |
| 🟡 | Trade adapter | L-01 and L-02 are fixed in source; the deployed adapter predates the fixes because a redeploy was deliberately deferred | [static/](static/README.md) |
| 🟡 | Circuit residuals | Two properties the circuits do not carry alone. Both are held by the pool or need a token that does not exist. Closing either costs a timelocked verifier swap | [circuits/](circuits/README.md) |

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
cli **8.9**, app **7.6**. The hosted run will differ because it also scores the
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
| ☐ | Scheduled runs on the VPS | — |
| ☐ | Notification channel | — |
| ☐ | Tenderly or Forta alert on turnstile divergence | — |

`npm run watch` is written, proven to alarm, and run by hand. It now covers the
relayer as well as the pool, and **measures the float from the chain rather than
from the daemon's own report** — a control that asks the thing it watches whether
it is well is not a control. Nothing schedules it yet, and nothing tells a person
when it speaks. That notification channel is the gap worth closing next: every
check that matters now exists and is addressed to nobody.

### Phase 4 — human eyes

| | Step | Artifact |
|---|---|---|
| ☐ | Hats Finance vault funded with $COWL | — |
| ☐ | Aztec grant application for a circuit review | — |
| ☐ | Immunefi, Sherlock, CodeHawks or Code4rena | — |
| ☐ | Firm engagement for the circuits | — |

Hats is the natural first move: the vault funds from the creator-fee stash
rather than from cash, and launching does not wait for a slot. The open question
is the amount.

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

Not in the plan, added because a green suite proves nothing on its own:
an invariant no mutation can violate is testing nothing. Six mutations, one per
pool defence, each caught by the invariant that names it.

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
npm run test:scanners                  # fails on any static finding nobody triaged
npm run test:relay -- --static         # the half of the relay check CI runs
./audits/static/scan.sh                # regenerates both scanner reports
cd contracts && forge test             # the whole contract suite
```

Two of these read live infrastructure and are deliberately kept out of CI, so
they only ever run when someone runs them:

```
npm run watch                          # governance + turnstile vs baseline
npm run test:relay                     # adds the live half: are the daemons current
```
