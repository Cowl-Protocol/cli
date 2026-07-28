# Audits

The index of every audit artifact in this repository, and the vocabulary they
share. The rule this directory enforces: a security claim without an artifact
behind it does not ship — not on the website, not in a tweet. Reports are
published whether or not the findings are flattering; an audit page that only
shows clean results is not evidence of anything.

## Completed

| Date | Work | Scope | Audited commit | Outcome | Report |
|---|---|---|---|---|---|
| 2026-07-28 | Static analysis — slither 0.11.5 + aderyn 0.6.8, every finding triaged against source | `ShieldedPool.sol`, `CowlTradeAdapter.sol` | `1cbb48a` | No path to deposited funds. 1 Medium mitigated, 2 Low fixed in source, 3 Informational acknowledged | [static/](static/README.md) |
| 2026-07-28 | Governance & turnstile monitoring — state watcher, recorded baseline, response playbook | Both live pools (mainnet 4663, testnet 46630) | live chain state | Turnstile exact to the wei on every token that entered through `shield()`; no pending verifier swaps; `npm run watch` | [monitoring/](monitoring/README.md) |

## Planned

In rough order. Each lands in this table with its artifact when it completes,
and not before.

| Work | What it can find that nothing above can |
|---|---|
| Foundry invariant suite | Pool accounting broken by call *ordering* — the drain class no concrete test reaches |
| Circuit adversarial harness | Under-constrained Noir circuits — the class that can empty the pool |
| Scanners in CI | Regressions of everything the static pass now covers |
| npm provenance | Supply chain: proof the published package is the published source |
| External review / competition | Everything the authors are blind to |

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
