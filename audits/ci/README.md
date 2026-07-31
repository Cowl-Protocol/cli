# Continuous integration

**Date** 2026-07-29 · **Workflows landed in** `cf9fdb6` (cli) and `b600bbc`
(app), **extended in** `94407b4` when the circuit harness added two steps ·
**Scope** `Cowl-Protocol/cli`, `Cowl-Protocol/app`

Two workflows at `.github/workflows/ci.yml`, one per repository, running on every
push to `main` and every pull request. Since 2026-07-29 each repository also
carries `.github/workflows/codeql.yml`.

**Why CodeQL is a second file rather than another job.** `ci.yml` declares
`permissions: contents: read` and nothing in it publishes, deploys or writes back
to a repository. CodeQL needs `security-events: write` to file alerts. Keeping it
separate keeps that property true for `ci.yml` instead of widening it to
accommodate one tool — the same reasoning that will apply when npm provenance
needs a publish workflow.

**CodeQL reports, it does not gate.** There is no fail-on-finding switch in the
action, and unlike the slither and aderyn gate below there is no baseline behind
it yet. Findings arrive as code-scanning alerts. Turning them into a triaged
report with verdicts is what completes that step, and it needs the first run to
exist first. It is scheduled weekly as well as on push, because CodeQL ships new
queries regularly and a push-only trigger never runs them against code that has
not changed.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Job | Covers | Result |
|---|---|---|---|
| 🟢 | cli · typecheck, build, unit tests | lockfile, types, bundle, denominations, relay table | green |
| 🟢 | cli · forge test | 78 contract tests from a clean clone | green |
| 🟢 | cli · invariant suite can fail | the pool mutation harness, 6/6 | green |
| 🟢 | cli · nargo test | 32 circuit tests, the circuit mutation harness 17/17, public inputs vs the pool | green |
| 🟢 | cli · static analysis | slither 0.11.5 and aderyn 0.6.8 against the recorded baseline, fails on anything untriaged | green |
| 🟢 | app · typecheck, offline checks, build | types, four offline verify scripts, production build | green |
| 🟢 | Supply chain | every action pinned to a full commit SHA, `contents: read`, no secrets | green |
| 🟡 | I-01 · the app's `lint` script has never worked | eslint 9 installed, no config file of any kind | open, deliberately not a gate |

**No gate reaches the network for a verdict**, which is the design rule below.
The only 🟡 is the app's lint script: it exits 2 today and always has, and a gate
that is red on its first run teaches everyone to ignore the red.

**Both workflows went green on their first real run**, and have stayed green
since the circuit harness extended the `circuits` job.

| Repo | Run | Head | Result |
|---|---|---|---|
| cli | [30436052024](https://github.com/Cowl-Protocol/cli/actions/runs/30436052024) | `cf9fdb6` | 4/4 jobs success — first run |
| app | [30436063309](https://github.com/Cowl-Protocol/app/actions/runs/30436063309) | `b600bbc` | success — first run |
| cli | [30437860292](https://github.com/Cowl-Protocol/cli/actions/runs/30437860292) | `94407b4` | 4/4 jobs success — with the circuit harness |

Durations from the `94407b4` run, which is the current shape of the pipeline:

| Job | Duration | Steps |
|---|---|---|
| cli · typecheck, build, unit tests | 19s | |
| cli · forge test | 64s | |
| cli · invariant suite can fail | 82s | |
| cli · nargo test | 37s | `nargo test` 6s, `mutants.mjs` 22s, public inputs 1s |
| app · typecheck, offline checks, build | 90s | npm ci 48s, typecheck 9s, offline checks 2s, build 24s |

**On the 6-second `nargo test` step.** That is fast enough to be worth doubting:
a step that runs 32 tests across three packages in six seconds could just as
easily be a step that ran nothing and exited green. The loop was checked directly
for that, outside CI, by giving it a failing package under `bash -e`, which is
the shell GitHub uses. It aborts on the failure with a non-zero status and never
reaches the third package, so a missing `nargo` (exit 127) or a single failing
circuit test turns the job red. The step being green therefore means all three
packages ran and passed. The speed is a prebuilt binary on a fast runner.

**How this was written, and what that cost.** `act`, `gh` and `actionlint` are
all absent from the build machine, so no GitHub Actions job could be run locally
before pushing. What was done instead: every command in both workflows was run
locally against a clean tree, both files were parsed as YAML, and every action
pin was checked to be a full 40-character SHA. That made the first push the first
real execution — which passed, but the sequence is worth naming, because it is
the one part of this phase that was argued before it was proven.

## The rule these workflows follow

**No gate reaches the network for a verdict.** Not the relayer, not an RPC, not
the deployed pool. A gate that goes red because a VPS blinked is a gate everyone
learns to route around, and a control nobody trusts is not a control — the same
standard the audit plan sets for scanners, applied to CI.

That rule cost something, and the cost is named here rather than hidden: the
checks that read live infrastructure are the only ones that catch a class of
fault the source cannot show. `npm run test:relay` without `--static` is the
only thing that catches a relayer daemon left running an older build, and
`npm run watch` is the only thing that reads the money. Both stay manual. Both
are listed in [`../README.md`](../README.md).

## cli — six jobs

| Job | Runs | Proven locally |
|---|---|---|
| `scanners` | `audits/static/check.mjs` — slither + aderyn against the baseline | 23 fingerprints matched; proven to bite by planting an unused state variable |
| `node` | `npm ci`, `typecheck`, `build`, `npm test`, `test:relay -- --static` | lockfile in sync via `npm ci --dry-run`; typecheck clean; `built dist/cli.mjs`; denominations all green; relay static half all green |
| `contracts` | `forge test` | 78 passed, 0 failed |
| `mutants` | `audits/invariant/mutants.sh` | 6/6 mutants caught, source restored |
| `supplychain` | `audits/supplychain/check.mjs` — install-script and advisory baseline | 2 install scripts accepted, 1 advisory triaged; proven to bite on all three drift classes |
| `circuits` | `nargo test` in `notes`, `shield`, `transfer`; then `audits/circuits/mutants.mjs`; then `nargo compile` and `audits/circuits/publicinputs.mjs` | 3 + 6 + 23 = 32 tests passed; 17/17 circuit mutants caught; 14 and 6 public inputs matched |

`forge test` runs from a clean clone with no `forge install` and no circuit
build, because forge-std is vendored and the proof fixtures are committed on
purpose (the reasoning is written into `.gitignore`). The `bench-*` circuit
packages are measurements rather than checks and are not run.

The `supplychain` job deliberately does **not** run `npm ci`. Its offline half
reads `package-lock.json` and nothing else, and installing the tree in order to
check whether the tree is safe to install would run the very scripts it exists to
notice. It is also the only job in the file that looks at what arrives from
outside; every other one reads code somebody here wrote.

**Both mutation harnesses run on every push**, and they are the pair that would
be easiest to leave out and hardest to notice missing. Without them an invariant
or a circuit test can be quietly weakened into one that constrains nothing, and
the suite stays green while covering less every month. Together they cost about
40 seconds.

The `circuits` job also compiles `transfer` and `shield` before checking their
public inputs against the pool, because the compiled artifacts are gitignored and
so are not there from a clean clone.

## app — one job

| Job | Runs | Proven locally |
|---|---|---|
| `web` | `npm ci`, `typecheck`, `test:offline`, `build` | lockfile in sync; `tsc --noEmit` clean; four checks pass; production build succeeds in 13s |

`test:offline` is four of the thirteen verify scripts: `capcheck`, `mergecheck`,
`qrcheck`, `retrycheck`. They are properties of the source, need no network, and
each finishes in under a second. `retrycheck` in particular guards the
resume-never-restart rule that exists because a retry once re-sent eight
deposits that had already landed.

The other nine are excluded, for three different reasons:

- `assetscheck`, `holdingscheck`, `pricecheck`, `rpccheck`, `relaycheck`,
  `feecheck` read live chain, relayer or price data.
- `sendcheck` and `crosscheck` build real proofs, which pulls the 52MB CRS and
  takes minutes.
- `crosscheck` and `tradecheck` import from `../../cli`, which does not exist in
  a clone of the app repository on its own. **This one is structural**: those two
  scripts can only ever run from the workspace layout, never from app CI.

## Supply chain

Every action is pinned to a full 40-character commit SHA with the version in a
trailing comment, not to a moving tag. A tag can be repointed by whoever controls
the action repository; a SHA cannot. This is what OpenSSF Scorecard's
pinned-dependencies check looks for, and it is cheaper to do now than to retrofit
when Scorecard lands as its own step.

| Action | Pinned SHA | Version |
|---|---|---|
| `actions/checkout` | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | v5 |
| `actions/setup-node` | `a0853c24544627f65ddf259abe73b1d18a591444` | v5 |
| `foundry-rs/foundry-toolchain` | `908c540300062bd5a7e473851cdb4282204cee09` | v1 |
| `noir-lang/noirup` | `7dbe69ccc78877f0200ffa5a40836c953d2cfd8f` | v0.1.4 |

Both workflows declare `permissions: contents: read` and check out with
`persist-credentials: false`. Nothing publishes, deploys, or writes back to a
repository, and no job uses a secret. When npm provenance lands it will need a
publish workflow with wider permissions, and that belongs in its own file rather
than widened into this one.

The Noir toolchain is pinned to `1.0.0-beta.22`, the version the circuits are
verified against locally. `noirup` prepends the `v` itself for a numeric version,
which is why the pin has no leading `v`.

## Changes this step required

**`test:relay` gained a `--static` flag.** The file had a static half, which is a
property of the source, and a live half, which asks two daemons for a quote. The
static half is the one that caught a real fault: a network shipped for two days
with a pool and no `defaultRelay`, so every mainnet spend went out from the
user's own wallet while the plan still called itself private. That check belongs
on every push. The live half stays on by default, so running the command by hand
is unchanged.

**`mutants.sh` stopped using `mktemp -t`.** That flag means different things to
BSD and GNU mktemp, so the script would have behaved one way on the laptop it was
written on and another on an Ubuntu runner. It now names the directory
explicitly.

**The app gained `typecheck` and `test:offline` scripts.** Both are thin wrappers
over commands that already worked, so CI names an npm script rather than
hardcoding a file list that would drift.

## Finding

### [I-01] The app's `lint` script has never worked

`npm run lint` exits 2. The repository has eslint 9 and `eslint-config-next`
installed but no eslint configuration file of any kind, so eslint reports the
flat-config migration error and stops before linting anything.

**Impact** None on shipped behaviour. It means the app has no lint coverage, and
that no lint regression has ever been reportable.

**Why it is not in CI** Adding a gate that is red on its first run teaches
everyone to ignore the red. Fixing it is a separate piece of work with an unknown
blast radius, since nobody knows how many findings a first successful lint run
produces.

**Status** Open. Left for a decision rather than fixed in passing.

## Reproducing the gates locally

```
# cli
npm ci && npm run typecheck && npm run build && npm test
npm run test:relay -- --static
cd contracts && forge test
./audits/invariant/mutants.sh
cd circuits && for p in notes shield transfer; do (cd $p && nargo test); done

# app
npm ci && npm run typecheck && npm run test:offline && npm run build
```
