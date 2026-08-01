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
| 🟢 | cli · relayer daemon under attack | the real daemon over a stub chain: 8 cases, then 8/8 mutants, plus the notification channel: 15 cases, then 12/12 mutants. No network, no key, loopback only | added 2026-08-01, lands with the push that carries it |
| 🟢 | app · typecheck, offline checks, build | types, eight offline verify scripts, production build | green |
| 🟢 | Supply chain | every action pinned to a full commit SHA, `contents: read`, no secrets | green |
| 🟢 | app · agrees with the CLI | both repositories checked out, the offline cross-check: field, note, cipher, key and Merkle parity | added 2026-08-01, lands with the push that carries it |
| 🟡 | I-01 · the app's `lint` script had never run | eslint 9, no config of any kind, so it exited 2 on every invocation since it was added | **config written, lint runs, backlog measured** — still not a gate |

**No gate reaches the network for a verdict**, with one deliberate exception:
the app's new `parity` job checks out the CLI as well, because what it verifies
is that two implementations compute the same numbers. It reaches another
repository rather than the network, and a change on the CLI's main turning it red
is the behaviour that job exists for.

### I-01, moved but not closed

The app's `lint` script now runs. `eslint.config.mjs` did not exist, and flat
config is mandatory in eslint 9, so `npm run lint` had exited 2 on every
invocation since the day it was added.

**What it found, measured 2026-08-01: 35 errors and 6 warnings.**

| Rule | Count | What it is |
|---|---|---|
| `react-hooks/set-state-in-effect` | 20 | setState called synchronously in an effect body |
| `react-hooks/preserve-manual-memoization` | 5 | memoization the compiler cannot preserve |
| `react-hooks/immutability` · `refs` · `purity` | 6 | refs written during render, one impure call during render |
| `prefer-const` | 3 | mechanical |
| `@next/next/no-html-link-for-pages` | 1 | an `<a>` where a `<Link>` belongs |
| `react-hooks/exhaustive-deps` and other warnings | 6 | |

**It is still not a gate, and the reason has changed.** It used to be that a
script which cannot run cannot gate anything. Now it is that 31 of the 35 errors
come from the React Compiler ruleset, and clearing them means restructuring
effects inside the live wallet provider — `ShieldedProvider.tsx` alone holds ten.
That is a change to code that signs and spends, made to satisfy a linter that was
installed the day before, and it is not a change to make in the same pass that
installed the linter.

### The six that were read

The `refs`/`immutability`/`purity` cluster was read rather than counted, because
a ref assigned during render to mirror state is the pattern React's concurrent
rendering makes unsafe, and most of them sit in the provider that holds the
shielded keys.

**`RunProgress.tsx:104` — rebutted.** `Date.now()` is called during render, which
the rule is right about in the letter. The component drives a 500 ms `tick`
interval for exactly this reason, so the countdown re-renders and stays
truthful. Deliberate, compensated, and the compensation is three lines above the
finding.

**`ShieldedProvider.tsx:335` — acknowledged.** `walletClientRef.current =
walletClient` during render is the ordinary latest-ref idiom, read only inside
callbacks at five call sites. Writing it in an effect instead would make it lag
by a paint, which is worse for what it is for.

**`ShieldedProvider.tsx:405` — the one that is worth acting on.**
`keysRef.current = keys` is the same idiom, but `keysRef` is not doing the same
job. It is doing two:

1. a latest-value cache, read by `ensureKeys` so a caller who already has keys is
   not asked to sign again, and
2. a **cancellation token** — line 395 drops a late sync result when
   `keysRef.current !== k`, which is how a read that outlives its deadline is
   discarded if the account was locked or switched meanwhile.

A latest-ref that is also a cancellation token is fragile in a way a plain one is
not, because the render-time write can undo a deliberate one. `ensureKeys` sets
`keysRef.current = k` and then `setKeys(k)`; a render scheduled by any other
update landing between those two writes runs line 405 with the **old** `keys`,
putting the ref back to `null`. The symptoms would be a second signature prompt
for keys the app already holds, or a late sync correction silently dropped with
`syncStale` left stuck on.

**It is also redundant.** `setKeys` has exactly three callers — lines 341, 444
and 461 — and each one already writes the ref beside it, at 340, 443 and 460. So
the render-time write synchronises nothing that is not already synchronised, and
deleting line 405 removes the only path that can clobber a deliberate write.

That is a one-line change in the component that signs and holds shielded keys,
so it is recorded here rather than made. **Reachability is unproven**: React 18
batches the ref write and the state update inside the same async continuation,
so the window is narrow today. It widens under StrictMode's double render and
under concurrent features, and the fix costs one deletion.

Nothing here reaches deposited value, and the build is unaffected — Next 16 no
longer runs ESLint during `next build`, which was confirmed by building with the
config in place rather than assumed.

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

## cli — seven jobs

| Job | Runs | Proven locally |
|---|---|---|
| `scanners` | `audits/static/check.mjs` — slither + aderyn against the baseline | 23 fingerprints matched; proven to bite by planting an unused state variable |
| `node` | `npm ci`, `typecheck`, `build`, `npm test`, `test:relay -- --static` | lockfile in sync via `npm ci --dry-run`; typecheck clean; `built dist/cli.mjs`; denominations all green; relay static half all green |
| `contracts` | `forge test` | 78 passed, 0 failed |
| `mutants` | `audits/invariant/mutants.sh` | 6/6 mutants caught, source restored |
| `supplychain` | `audits/supplychain/check.mjs` — install-script and advisory baseline | 2 install scripts accepted, 1 advisory triaged; proven to bite on all three drift classes |
| `relayer` | `audits/relayer/attack.mjs`, `audits/relayer/mutants.mjs`, then `audits/monitoring/notify-mutants.mjs` | 8/8 cases held in 8s; 8/8 mutants caught, sources restored byte for byte; the notification channel's 15 cases and 12/12 mutants in 35s |
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

**Every mutation harness runs on every push** — four of them now: the invariant
suite's, the circuits', the relayer's and the notification channel's. They are
the ones that would be easiest to leave out and hardest to notice missing.
Without them a test can be quietly weakened into one that constrains nothing,
and the suite stays green while covering less every month.

They are also the only jobs that edit first-party source, and since 2026-08-01
they share a lock so two can never run at once — the second one's "original"
would be the first one's mutant, and its restore would write a weakened file
back as the baseline. CI runs them on separate runners, so the lock is never
contended there; it is for the machine where somebody starts two by hand, which
is how it was found. See [`../README.md`](../README.md).

The `circuits` job also compiles `transfer` and `shield` before checking their
public inputs against the pool, because the compiled artifacts are gitignored and
so are not there from a clean clone.

## app — three jobs

| Job | Runs | Proven locally |
|---|---|---|
| `web` | `npm ci`, `typecheck`, `test:offline`, `build` | lockfile in sync; `tsc --noEmit` clean; eight checks pass; production build succeeds |
| `parity` | both repositories checked out, then `crosscheck.mts --offline` and `tradecheck.mts --offline` | field, note, cipher, key and Merkle parity in ~4s; the trade plan, value conservation and CLI wire parity in 20 checks |
| `supplychain` | `audits/supplychain/check.mjs` over its own lockfile | 8 install scripts and 27 advisories, each with a written verdict |

`test:offline` is eight of the seventeen verify scripts: `capcheck`,
`mergecheck`, `qrcheck`, `retrycheck`, `synccheck`, `maxcheck`,
`transportcheck`, `publicbookcheck`. They are properties of the source, need no
network, and each finishes in under a second. `retrycheck` in particular guards
the resume-never-restart rule that exists because a retry once re-sent eight
deposits that had already landed.

`crosscheck` and `tradecheck` are the ninth and tenth, in their own job because
they are the two that read another repository.

**The claim this section used to make about it was wrong, and it is worth saying
so plainly.** It read: *"crosscheck and tradecheck import from `../../cli`,
which does not exist in a clone of the app repository on its own. This one is
structural: those two scripts can only ever run from the workspace layout, never
from app CI."*

Structural was the wrong word. A workflow can check out two repositories, which
is what the `parity` job does; and the other half of the exclusion — that
crosscheck builds a real proof — was answered by giving it an `--offline` mode
that skips the prover and the chain replay. Neither obstacle was structural.
Both were defaults nobody had pushed on.

`tradecheck` came in the same way, and it took a second look to see it. The
first version of this rewrite still listed it as excluded "because it also needs
a venue" — which was repeating the reason rather than checking it. Five of its
seven sections need nothing but source: the spend leg binding the adapter, value
conservation to the wei, the legs chaining, byte-identical wire format against
the CLI, and the executor's promises pinned in source. Only the venue and relayer
quotes reach a network, and `--offline` drops exactly those. Twenty checks now
run on every push that never did.

The seven still excluded, for two reasons rather than three:

- `assetscheck`, `holdingscheck`, `pricecheck`, `rpccheck`, `relaycheck`,
  `feecheck` read live chain, relayer or price data, so they fail for reasons
  that have nothing to do with the commit under test.
- `sendcheck` builds a real proof, which pulls the 52MB CRS and takes minutes.

**Both remaining reasons are about what a gate should be, not about what is
possible.** That distinction is the lesson of this section: the previous version
of it called an exclusion *structural* when it was a default nobody had pushed
on, and two scripts came into CI the moment somebody did.

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
