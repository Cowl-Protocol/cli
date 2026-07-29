# Audits

The index of every audit artifact in this repository, and the vocabulary they
share. The rule this directory enforces: a security claim without an artifact
behind it does not ship — not on the website, not in a tweet. Reports are
published whether or not the findings are flattering; an audit page that only
shows clean results is not evidence of anything.

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
| ☐ | Circuit adversarial harness | — |
| ☑ | Foundry invariant suite | [invariant/](invariant/README.md) |

The plan calls the middle step "Noir fuzz harnesses" and describes it as giving
the existing `#[test]` functions arguments so `nargo` fuzzes them. **That is not
sufficient and the step is deliberately renamed.** Fuzzing the inputs of `main`
only demonstrates that valid witnesses are accepted. The class of bug that
empties a pool is the opposite one, a circuit that accepts a witness it should
reject, and reaching it needs adversarial witness generators, `should_fail`
tests, and wider differential coverage in `crosscheck.mts`.

`gh`, `act` and `actionlint` are all absent from the build machine, so workflows
are written locally, every command in them is proven locally, and the workflows
themselves are first exercised by the push that lands them. Both went green on
that first run.

### Phase 1 — free tooling

| | Step | Artifact |
|---|---|---|
| ☑ | Slither, every finding triaged against source | [static/](static/README.md) |
| ☑ | Aderyn, same | [static/](static/README.md) |
| ☐ | CodeQL (app, cli) | — |
| ☐ | OpenSSF Scorecard | — |
| ☐ | Dependabot | — |
| ☐ | Socket | — |
| ☐ | Scanners wired into CI, build fails on high severity | — |

Both scanners run today from [`static/scan.sh`](static/scan.sh) and their output
is triaged by hand. Wiring them into every push is now unblocked, since
[ci/](ci/README.md) landed. The plan's own standard applies until then: a
scanner nobody is forced to read is not a control.

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
| ☐ | Scheduled runs on the VPS | — |
| ☐ | Relayer float check | — |
| ☐ | Notification channel | — |
| ☐ | Tenderly or Forta alert on turnstile divergence | — |

`npm run watch` is written, proven to alarm on simulated drift, and run by hand.
Nothing schedules it yet. The relayer float is the gap worth closing next: it
empties silently, and gasless stops for everyone the moment it does.

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

Not in the plan, added because a green suite proves nothing on its own:
an invariant no mutation can violate is testing nothing. Six mutations, one per
pool defence, each caught by the invariant that names it.

## Reports

| Date | Work | Scope | Audited commit | Outcome | Report |
|---|---|---|---|---|---|
| 2026-07-28 | Static analysis — slither 0.11.5 + aderyn 0.6.8, every finding triaged against source | `ShieldedPool.sol`, `CowlTradeAdapter.sol` | `1cbb48a` | No path to deposited funds. 1 Medium mitigated, 2 Low fixed in source, 3 Informational acknowledged | [static/](static/README.md) |
| 2026-07-28 | Governance & turnstile monitoring — state watcher, recorded baseline, response playbook | Both live pools (mainnet 4663, testnet 46630) | live chain state | Turnstile exact to the wei on every token that entered through `shield()`; no pending verifier swaps; `npm run watch` | [monitoring/](monitoring/README.md) |
| 2026-07-29 | Invariant suite — six pool properties under randomised call sequences, verifier stubbed to accept everything | `ShieldedPool.sol` | `5eb31a8` | All six held across 245,760 calls. Suite proven able to fail: 6/6 mutations caught. 2 Informational, both unreachable through a sound verifier | [invariant/](invariant/README.md) |
| 2026-07-29 | Continuous integration — build, typecheck, contracts, circuits and the mutation harness on every push, both repos | `Cowl-Protocol/cli`, `Cowl-Protocol/app` | `cf9fdb6`, `b600bbc` | 5 jobs, all green on the first real run. Every action SHA-pinned, no gate touching live infrastructure. 1 Informational (the app's lint script has never worked) | [ci/](ci/README.md) |

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
npm run test:relay -- --static         # the half of the relay check CI runs
./audits/static/scan.sh                # regenerates both scanner reports
cd contracts && forge test             # the whole contract suite
cd circuits/transfer && nargo test     # the transfer circuit
```

Two of these read live infrastructure and are deliberately kept out of CI, so
they only ever run when someone runs them:

```
npm run watch                          # governance + turnstile vs baseline
npm run test:relay                     # adds the live half: are the daemons current
```
