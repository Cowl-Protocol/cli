# CodeQL — the clients, read by a machine

Audit plan Phase 1. The workflows have been in both repositories since
2026-07-29, running on every push and weekly. Until now **nobody had read the
output**, which by this tree's own rule means the step was not done: a scanner
nobody is forced to read is not a control.

Read on 2026-07-31, by running CodeQL locally rather than waiting for access to
the Security tab.

## What was run

| | |
|---|---|
| CodeQL | **2.26.2**, the same version `codeql-bundle-v2.26.2` ships to the action |
| Suite | `javascript-security-extended.qls` — the same `security-extended` the workflows ask for |
| Scope | `javascript-typescript` across both repositories |
| Files | 43 in `cli`, 76 in `app`, `node_modules` and build output excluded |

The bundle was downloaded and its SHA-256 checked against the published
`codeql-bundle-osx64.tar.zst.checksum.txt` before it was unpacked. A 959MB
binary pulled off the internet and run against a repository holding money is
not something to take on faith, in the same week as a supply-chain audit.

## Results

**Four findings across both repositories.** One was real and is fixed. Three are
false positives with the reasoning below.

| | Repository | Rule | Where | Verdict |
|---|---|---|---|---|
| Q-01 | cli | `js/file-system-race` | `audits/supplychain/check.mjs:88` | **Fixed** |
| Q-02 | cli | `js/file-access-to-http` | `src/relayer/client.ts:181` | Not a vulnerability |
| Q-03 | cli | `js/file-access-to-http` | `src/shielded/betacap.ts:114` | Not a vulnerability |
| Q-04 | app | `js/missing-origin-check` | `lib/shielded/proveWorker.ts:20` | False positive |

Nothing in the proving path, the note handling, the key derivation or the wire
format was flagged. Neither was any of the circuit-adjacent code. For a
`security-extended` run over two clients that move real money, four findings and
one fix is a clean result — and it is worth being precise about what that means:
CodeQL reads dataflow in TypeScript. It does not know what a nullifier is.

## Q-01 — check-then-use race, in code from the same session

`audits/supplychain/check.mjs` tested `existsSync(BASELINE)` and then read the
file, which is a TOCTOU: the file can change between the two calls.

Impact is essentially nil — a local dev tool, no privilege boundary, and an
attacker who can swap that file already has the repository. It is recorded and
fixed anyway for two reasons. The code is now simply better: reading first and
explaining on failure cannot report "missing" for a file that is present but
unreadable. And **this is the tool finding a real defect in code written hours
earlier**, which is the argument for running it at all.

Fixed by replacing both pre-checks with a `readJson()` helper that reads, then
distinguishes `ENOENT` from an unreadable file from malformed JSON. Error paths
tested by hand: missing baseline, malformed baseline, and the normal run.

**Verified by re-running CodeQL, not by assuming.** The cli went from 3 findings
to 2, and `js/file-system-race` is gone.

## Q-02 and Q-03 — outbound requests shaped by a config file

Both say the same thing: data read from a file reaches a `fetch()`.

- `client.ts:181` — the relayer URL, from `~/.cowl/config.json` or `--relay`
- `betacap.ts:114` — the explorer URL, from the same config

The query is looking for SSRF: a server reads a file an attacker uploaded, then
fetches whatever it says. That shape does not exist here. The "file" is the
user's own config on their own machine, the CLI is not a server, and there is
**no privilege boundary between the file and the process** — anyone who can
write that config can already run any command as that user.

The residual, stated honestly: an attacker who could rewrite the config could
point the relayer at a host they control. That host cannot alter the spend,
because the proof binds `recipient`, `relayer` and `fee` and any change stops it
verifying. It could refuse to submit, and it could see the spend's ciphertexts
and public legs. But the same attacker already has read access to the keystore
directory, so this grants nothing they did not have.

**Not a vulnerability. Configurable endpoints are the feature.**

## Q-04 — no origin check on a postMessage handler

`proveWorker.ts` handles `self.onmessage` without checking `event.origin`.

The query is written for `window.addEventListener("message", …)`, where any
frame or opener can post and the origin is the only thing separating callers.
`proveWorker.ts` is a **dedicated** Web Worker, created by `new Worker(...)` in
`prover.ts:23`. A dedicated worker has exactly one client, the context that
constructed it, and nothing else can reach its port. `MessageEvent.origin` is
the empty string for dedicated-worker messages, so the check the query wants is
not merely unnecessary, there is nothing to compare.

**False positive for this worker type.** It would be a real finding on a
`SharedWorker` or a window listener, and it is worth remembering that if the
proving worker is ever shared between tabs.

## Reconciling this with the hosted run

These are local results and they will not match the Security tab exactly.

- The hosted run analyses the **pushed commit**. This one analysed the working
  tree, which is why Q-01 could be found in a file that is not committed yet.
- Query packs update on GitHub's schedule. A new query can surface a finding
  that did not exist when this ran, which is the entire point of the weekly
  schedule in `codeql.yml`.
- The action **reports, it does not gate** — there is no fail-on-finding switch —
  so alerts accumulate until a human reads them.

When the first hosted run lands, its alerts should be read against the verdicts
above rather than triaged from scratch. Anything not in this table is new.

## Reproducing

```bash
codeql database create db --language=javascript-typescript --source-root=<repo>
codeql database analyze db --format=sarif-latest --output=out.sarif \
  codeql/javascript-queries:codeql-suites/javascript-security-extended.qls
```

The CodeQL CLI is **not** installed on the build machine and is not vendored
here: it is a 959MB download and a ~2GB unpack, which does not belong in a
repository. Neither is the SARIF, which is a machine artifact of a run against a
tree that no longer exists. The verdicts are the artifact.
