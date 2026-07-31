# Supply chain — what arrives from outside

Audit plan Phase 1, the supply-chain steps. Every other control in
this tree reads code somebody here wrote: slither and aderyn read our Solidity,
CodeQL reads our TypeScript, the invariant suite attacks our pool, the circuit
harness attacks our constraints. **None of them can see the packages that arrive
with `npm i`**, and on a global install those land on the same machine as a
keystore.

Covers both repositories. `Cowl-Protocol/cli` is what users install;
`Cowl-Protocol/app` is what builds the bundle their browser runs.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale in [`../README.md`](../README.md).

| | Check | Read 2026-07-31 |
|---|---|---|
| 🟢 | Nothing in either tree reaches a user's keys | 36 app advisories and 1 cli advisory, all read, none reachable. Evidence below |
| 🟢 | Install scripts in what a user installs | exactly one, optional, and the CLI is proven to work without it |
| 🟢 | Gate on anything new entering | [`check.mjs`](check.mjs), proven to fail on all three drift classes |
| 🟢 | Dependency updates watched | Dependabot on npm and actions, both repos, with the two proof-critical pins refused |
| 🟢 | Third party posture grade | OpenSSF Scorecard 5.5.0 run locally: cli **8.9**, app **8.0**, every check given a verdict below |
| 🟡 | The app carries 929 packages against the cli's 70 | build-time only, and the reason the build machine is now the highest-value target in the project |
| 🟡 | Socket not installed | it is a GitHub App, so only the account owner can add it. `check.mjs` covers the install-script half it is best at |
| 🟡 | 36 app advisories are unreachable, not absent | rebutted with evidence, not fixed. Bumping Next.js closes most of them and is a real change to make deliberately |

**No 🔴.** Nothing found here reaches deposited value.

**The workflows have never run in CI.** Scorecard and the `supplychain` job both
land with the push that carries them, which is the position every workflow in
this repository started from. Everything they will run was proven locally first,
and every verdict here comes from a local run against the real lockfiles and the
real repositories.

```
node audits/supplychain/check.mjs            # check
node audits/supplychain/check.mjs --update   # re-record install scripts only
```

Exit codes **0** nothing new, **1** something new, **2** could not check.

## What a user actually installs

`npm i -g @cowlprotocol/cli` publishes only `dist`, `README.md` and `LICENSE`,
and pulls **43 production packages**. The other 27 in the lockfile are dev-only
and never leave this machine.

Of those 43, **exactly one runs an install script**:

```
@aztec/bb.js → msgpackr → msgpackr-extract   (optionalDependency, hasInstallScript)
```

`optional` here means npm tolerates it failing, **not** that it declines to run
it. So the honest statement is that installing the CLI executes one third-party
install script as whoever typed the command.

### Proven: the CLI does not need it

Installed the published 0.6.12 from the registry with `--ignore-scripts` into a
clean directory, 37 packages, no native build produced:

| Check | Result |
|---|---|
| `cowl --version` | `0.6.12` |
| `cowl network list` | all three networks, RPCs resolved |
| `cowl receive --help` | command tree intact |
| `msgpackr` pack/unpack round trip | byte-identical |

So the mitigation costs nothing, and the install line in the README can carry
`--ignore-scripts` for anyone who wants it. Recorded as **S-02** below.

## The app is the higher-value target

929 packages against the cli's 70, and 8 of them run install scripts. None of it
ships: `next.config.ts` sets `output: "export"`, so production is static files
behind Caddy with **no Next.js server anywhere**.

That does not make it safer, it moves the risk. The build machine turns those
929 packages into the bundle every browser executes, and that bundle is where a
wallet signature is turned into a spending key. **A compromised build-time
dependency is the shortest path in this project from a bad package to somebody's
money** — shorter than anything in the pool, which is immutable and audited from
four directions.

Nothing in this report says that has happened. It says it is the vector worth
spending the next hour of paranoia on, rather than the contracts.

## The 36 app advisories, and why none of them reach anyone

Grouped by root cause. Severities are npm's, not this tree's.

| Package | Count | Verdict |
|---|---|---|
| `next` | 9 | **Unreachable in production.** Every one is a server-side issue: Server Actions, Server Functions, the Image Optimization API, Edge runtime, rewrites, middleware, cache confusion. `output: "export"` means no Next server exists to attack. They are live in `next dev` on a developer's laptop, which is where they stay |
| `axios` | 9 | **Not in the bundle.** Arrives via `@coinbase/cdp-sdk` and `axios-retry`. Zero occurrences across 227 shipped chunks |
| `postcss` | 2 | **Build-time.** Processes our own CSS. The HIGH is arbitrary file read via an attacker-controlled `sourceMappingURL`, which requires attacker-controlled CSS, which requires a compromised dependency first |
| `ws` | 2 | **Not in the bundle.** WalletConnect's Node transport via `isows`; browsers get native `WebSocket`. Zero occurrences, and no `new WebSocket` either |
| `sharp` | 1 | **Never invoked.** `images: { unoptimized: true }` and no `next/image` import anywhere in `app/` or `components/` |
| `brace-expansion` | 1 | **Build tooling.** Glob expansion during build, DoS only |
| `uuid` | 1 | Missing bounds check when a caller supplies its own buffer. Nothing does |

### How "not in the bundle" was established

Not by reading the dependency graph, which says what could be included, but by
grepping the 227 chunks and 16MB actually in `out/_next/static/chunks`:

| Searched | Chunks |
|---|---|
| `axios` | 0 |
| `isows` | 0 |
| `brace-expansion` | 0 |
| `libvips` | 0 |
| `msgpackr` | 0 |
| `new WebSocket` | 0 |

A clean sweep proves nothing on its own, so the method was checked against
strings that must be present: `zcowl` 3, `shielded` 12, `WalletConnect` 29,
`coinbase` 26. The grep finds what is there. `coinbase` at 26 and `axios` at 0 in
the same sweep is the precise result — the connector is bundled, the SDK path
that pulls axios is tree-shaken out.

## OpenSSF Scorecard, run locally

Scorecard 5.5.0, downloaded and checksum-verified against the published
`scorecard_checksums.txt`, run in `--local` mode on 2026-07-31.

| Repository | Score | Was |
|---|---|---|
| `cli` | **8.9 / 10** | 8.1 before `SECURITY.md` |
| `app` | **8.0 / 10** | 6.8 before `SECURITY.md`, 7.6 before `LICENSE` |

### The first result was wrong, and the reason matters

The first run scored `cli` 6.9 and `app` 5.4, with **Binary-Artifacts at 0** on
both and a pinning warning against `comlink/Dockerfile`. Every one of those
warnings pointed inside `node_modules`, which is gitignored and not in either
repository.

**`--local` scans the working directory, not the git tree.** Re-run against a
clean `git archive` export, Binary-Artifacts is **10** on both and the app's
Pinned-Dependencies goes 8 to **10**. The published score, which reads the
repository, will match the clean numbers rather than the first ones.

Recorded here because it is the same trap as everything else in this tree: a
tool produced a confident number, and the number was about the method rather
than the subject.

### What each check says, and the verdict

| Check | cli | app | Verdict |
|---|---|---|---|
| Token-Permissions | 10 | 10 | Every workflow declares the minimum. `ci.yml` stays `contents: read`; the two that publish carry their own file |
| Dangerous-Workflow | 10 | 10 | No untrusted input reaches a run step, no `pull_request_target` |
| Pinned-Dependencies | 8 | 10 | **15 of 15 GitHub-owned and 5 of 5 third-party actions pinned by SHA**, which is the convention this project already ran on. See S-04 for the cli's one deduction |
| Binary-Artifacts | 10 | 10 | Nothing committed that a human cannot read |
| SAST | 10 | 10 | CodeQL is detected in both |
| Dependency-Update-Tool | 10 | 10 | Dependabot, added this session |
| Security-Policy | 10 | 10 | `SECURITY.md`, added this session. Was 0 on both |
| License | 9 | 9 | Both MIT, both detected. 9 rather than 10 in both repositories, which is the ceiling Scorecard gives this file's shape |
| Vulnerabilities | 9 | 0 | The advisories triaged above. The score is a count, not a reachability judgement |
| Fuzzing | 0 | 0 | **A false negative.** Scorecard detects OSS-Fuzz and ClusterFuzzLite integrations, and this project fuzzes through neither. It ran 245,760 randomised calls against the pool and an adversarial witness harness against the circuits, both in CI, both with mutation harnesses. Not worth chasing a score that measures which vendor rather than whether |
| Packaging | -1 | -1 | Inconclusive in local mode, which cannot see release history |

### What the hosted run will add

The published workflow scores checks `--local` cannot: Branch-Protection,
Code-Review, Maintained, CI-Tests, Contributors, Signed-Releases. Those are about
the GitHub account and its history rather than about this code, several are
things only the account owner can change, and **the published score will differ
from the numbers above**. These are the checks that read the repository; those
read the project around it.

## Findings

| ID | Severity | Status | What |
|---|---|---|---|
| S-01 | Informational | **Acknowledged** | `esbuild` 0.23.1 carries GHSA-67mh-4wv8-2f99, a development-server issue. Nothing here starts one; `build.mjs` and `watch-pool.mjs` call `build()` and exit. Dev-only, so no user installs it. The app already runs `^0.28.1`, so this is also a version skew between the two repositories that a bump would close |
| S-02 | Informational | **Acknowledged** | Installing the CLI runs one third-party install script (`msgpackr-extract`, optional, via bb.js). Unavoidable without dropping bb.js, and proven unnecessary: the published CLI works fully under `--ignore-scripts` |
| S-03 | Low | **Mitigated** | 36 advisories in the app tree, none reachable in the shipped bundle, all rebutted with the evidence above. Mitigated rather than fixed: the packages are still there, and a future build could pull a version where the reasoning no longer holds. `check.mjs` is what catches that |

| S-04 | Informational | **Acknowledged** | `pip install slither-analyzer==0.11.5` in `ci.yml:92` is version-pinned but not hash-pinned, the cli's only Pinned-Dependencies deduction. Hash-pinning it means a full `--require-hashes` requirements file covering slither's whole transitive tree, resolved for the Linux runner from a macOS machine, which is a real chance of breaking a working gate to move a score by two points. The job runs on an ephemeral runner under `contents: read` with no secrets and nothing to steal, so a compromised wheel would execute in a sandbox and end there. Left as is, deliberately |
| S-05 | Informational | **Fixed** | The `app` repository had no `LICENSE`, scoring 0. Now MIT, matching the cli, with the same copyright holder and a `license` field in `package.json` to go with it. License 0 to 9, aggregate 7.6 to 8.0 |

Impact is measured against deposited value first. None of these touch it, which
is why none is above Low.

## The gate

[`check.mjs`](check.mjs) compares the tree against
[`baseline.json`](baseline.json) and fails on anything new. Two halves:

**Install scripts**, offline, from the lockfile alone. This is the half that
matters. A package that gains an install script between two releases is the
whole modern supply-chain attack in one event, and it is invisible to every
other control in this tree. It also fails when a script-carrying package moves
from dev into production, because who runs it is the entire severity.

**Advisories**, which need the registry and degrade to exit 2 rather than
pretending a clean result. `npm audit` alone would be the always-red gate
[`../static/check.mjs`](../static/check.mjs) warns about, so it compares against
accepted advisories instead.

**`--update` re-records install scripts only, never advisories.** Accepting an
advisory means writing down why it does not reach anything, which is a sentence a
person has to author. A flag that swept them in would turn triage into a
keystroke and the baseline would stop meaning "read and rebutted".

### Proven able to fail

| Drift | Result |
|---|---|
| A package runs an install script that is not in the baseline | caught, exit 1 |
| A baselined dev script appears in the production tree | caught, exit 1 |
| An advisory nobody has triaged | caught, exit 1 |
| Baseline restored | exit 0 |

## Dependabot, and the two pins it must never touch

Both repositories watch npm and `github-actions` weekly. The actions entry is
not decoration: every action here is pinned to a commit SHA, which is correct and
also means the pins never update themselves.

Two dependencies are **refused** in both configs:

- `@aztec/bb.js`
- `@noir-lang/noir_js`

The pool at `0x6f98666e…6a3E` is immutable and holds real money. Its verifiers
were generated from these exact versions, and a proof is only accepted if it is
the bytes that verifier expects. A different Barretenberg produces a different
encoding and a different verification key, so a bump does not update a
dependency — it stops every spend in both clients from verifying, against a
contract nobody can patch. Moving them is a project with a 7-day timelocked
verifier swap behind it, never a dependency PR.

The app additionally refuses `qr`, whose 0.6.0 conflicts with RainbowKit's
`cuer`; `package.json` already carries an `overrides` entry pinning it back, and
a bump would reopen a conflict that was resolved by hand once.

## Not yet done

- **Socket is not installed.** It is a GitHub App, so only the account owner can
  add it, and its best signal (a package gaining an install script or new network
  access) is the half `check.mjs` now covers locally.
- ~~**The app has no gate of its own.**~~ **Closed 2026-08-01.** The app now runs
  this same gate on every push, with its own baseline over its own lockfile: 8
  install scripts and 27 advisories, each carrying a written verdict, in
  [`Cowl-Protocol/app` → `audits/supplychain/`](https://github.com/Cowl-Protocol/app/blob/main/audits/supplychain/README.md).

  Duplication won over extraction, and the drift that made it the worse option is
  now checked rather than trusted. **The two copies are byte-identical**, each
  baseline records the sha256 of the file beside it, and each copy checks its
  own — so editing either one turns that repository red until somebody
  re-records it, which is exactly the moment to copy the change across. Comparing
  `twinSha` across the two baselines answers "are these in sync" without reading
  either file. The guard was proven to fire before it was recorded.
- **The advisories are rebutted, not closed.** Bumping Next.js would close most
  of the 36 outright. That is a real change with a real regression surface, so it
  is a deliberate piece of work rather than something to fold into this step.
- **No provenance on what we publish** — Phase 2, and blocked on a decision about
  releasing from CI rather than on any work here.
