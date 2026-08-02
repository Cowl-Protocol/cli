# Static analysis — contracts

Audit plan Step 0. Run 2026-07-28 against `1cbb48a`.

Both scanned contracts are the source behind the live mainnet pool
`0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E`: `ShieldedPool.sol` has not changed
since `309ca6e` (2026-07-23) and `CowlTradeAdapter.sol` since `b4f70fd`
(2026-07-24), both at or before the mainnet deploy on 2026-07-24. That is a git
fact, not a bytecode comparison — verifying the deployed bytecode against this
source is a separate job and has not been done.

| | |
|---|---|
| Tools | slither 0.11.5, aderyn 0.6.8, forge 1.7.1 (solc 0.8.35) |
| Scope | `ShieldedPool.sol`, `CowlTradeAdapter.sol`, `TestVenue.sol` — 563 nSLOC |
| Out of scope | `ShieldVerifier.sol`, `TransferVerifier.sol` — bb-generated, see [scan.sh](scan.sh) |
| Raw output | [`slither-report.txt`](slither-report.txt), [`slither-raw.json`](slither-raw.json), [`aderyn-report.md`](aderyn-report.md) |
| Reproduce | `cli/audits/static/scan.sh` |

Test baseline at the same commit, both green before and after this scan:
62 Foundry tests, 12 Noir tests in `circuits/transfer`.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Finding | Severity | Where it stands |
|---|---|---|---|
| 🟢 | Path to deposited funds | — | **Neither tool found one.** Every finding read against source |
| 🟢 | Regression gate | — | Runs on every push; fails on anything untriaged. Proven to bite — see below |
| 🟢 | M-01 · verifier-swap escape hatch | Medium | **Closed 2026-08-02.** Both pools are owned by a 2-of-3 Safe at `0x708c36A9A54FfbFd16130eF0D9F7F581b90054f3`; one stolen key no longer reaches the hatch, nor can it renounce. Watched every 15 minutes: [`../../deploy/multisig/`](../../deploy/multisig/README.md) |
| 🟢 | L-01 · adapter refund `transfer` return unchecked | Low | **Closed 2026-08-02** — fixed, deployed and verified on both chains, and reached by every client: CLI 0.6.15, both relayers, and the browser app |
| 🟢 | L-02 · adapter `approve` returns unchecked, 3 sites | Low | **Closed 2026-08-02** in the same adapter; fails closed either way |
| 🟡 | I-01 · adapter is a one-way sink | Informational | Acknowledged — holds funds for one transaction by design |
| 🟡 | I-02 · fee-on-transfer tokens desync their own `pooledValue` | Informational | Acknowledged — bounded per token by the turnstile |
| 🟡 | I-03 · USDT-shaped tokens cannot shield | Informational | Acknowledged — fails closed |

**Why L-01 and L-02 are 🟡 and not 🟢, and why that is now a decision rather than
a delay.** They are fixed in this repository; the deployed adapter predates the
fixes. Nothing on chain carries them, so the source and the running contract
differ, and this table says so rather than letting a green tick imply otherwise.

**Decided 2026-08-02, then reversed the same day — and the reversal is the more
interesting half.** The first decision was to declare the deployed build in scope
and let the fixes ride the next release, on the argument that neither finding
reaches anyone's principal. That reasoning still stands on its own terms and is
kept below.

What overrode it was a standing position rather than a new fact: **a bug gets
fixed however small it is.** The owner's call, and the right one to defer to —
the cost side of the argument was a judgement about release effort, not about
safety, and the person carrying that effort is entitled to spend it.

**Deployed.** New adapter `0x55B0fD7EB8a9c8F54CF52b57961412FDc53fbB7D` on mainnet and
`0xD7839eC2AbBCcADf77995Af633510b1A3Cdc0726` on testnet, both verified, both proven by
comparison against a local build. A real private trade ran through the testnet
one before mainnet was touched — 0.1 USDG received, 8.7M gas, nothing left
stranded in the adapter.

**And the redeploy found something the reasoning below had missed entirely:**
[R-07](../relayer/README.md). A relayer accepted exactly one adapter address, so
the first trade through the new one was refused — by our own infrastructure, not
by the contract. Both directions of that failure cut off users mid-upgrade. That
is a defect neither audit nor verification would have surfaced, and only doing
the thing revealed it.

**Rollout, 2026-08-02.** `@cowlprotocol/cli@0.6.15` published with both new
addresses and the R-07 fix; both relayers upgraded and restarted; and a gasless
private trade run through the new adapter end to end — the same command that had
been refused an hour earlier, this time submitted by the relayer with the user's
wallet nowhere in the transaction.

**Closed the same day.** The browser client shipped the new addresses too, with
both feature gates left exactly as they were — the airdrop batch is finished and
Earn is still testnet, so neither was opened by a deploy that was about something
else. Every client now reaches the fix.

The reasoning is a comparison of what each side costs.

*What a redeploy buys.* L-01 strands the trader's **own unspent surplus** in the
adapter, after their trade has already settled correctly, and only for a token
that returns `false` instead of reverting. No user principal, no pool balance,
nobody else's money. L-02 fails closed — the trade reverts and nothing is at
risk.

*What a redeploy costs.* It is not a transaction, it is a release: deploy, change
`tradeAdapter` in `src/networks.ts`, publish the CLI, ship the app — and every
user who has not upgraded keeps routing through the old adapter regardless. A
release carries its own risk, and spending it on an edge case that reaches
nobody's principal is the wrong trade.

*What the delay used to cost, and no longer does.* The real problem was never the
bug, it was the **ambiguity**: a researcher reading `main` saw code that differs
from what runs. That is closed. The deployed commit is pinned to `8b1c58f~1` by
bytecode comparison and the running source is verified on the explorer, so the
gap is now a documented fact rather than an unknown.

Reversal condition, so this does not quietly become permanent: **the next time
the adapter is redeployed for any reason, these fixes go with it.** They are
already in `main` and already pinned by tests that fail without them, so that
costs nothing to honour.

## The gate — `check.mjs`

The scan became a control on 2026-07-29. It runs in CI on every push.

**It cannot fail on "the scanner found something".** Both scanners find
something on every run and always will: 15 slither findings and 17 aderyn
instances survive the current triage, every one read against source and written
up below. A gate that is red forever is a gate everyone learns to route around.

So the gate compares against a recorded baseline and **fails on anything new**,
at any severity. Same shape as the pool watcher in
[`../monitoring/`](../monitoring/README.md): the accepted state is committed, and
the check is about drift from it.

```
npm run test:scanners                       # scan and compare
node audits/static/check.mjs --update       # re-record after a triage pass
```

Exit codes: **0** nothing new · **1** something untriaged, or the baseline is
stale · **2** could not check, a scanner is missing or produced nothing. The last
one is deliberately distinct, for the same reason the pool watcher separates it:
a check that cannot tell "nothing new" from "could not tell" is not a check.

**Not severity-gated, on purpose.** The plan asked for the build to fail on high
severity. That is the wrong line here and this report is the evidence: the two
findings both tools rank highest are `arbitrary-send-eth`, and both were read
against source and rebutted below. Gating on severity would fail the build on
those forever while waving through a fresh Informational nobody has looked at.
Untriaged is the property that matters.

**The fingerprint carries no line numbers.** A finding is identified by detector
plus the contract and function it lives in. Line numbers move whenever anyone
edits anything above them, and a gate that goes red on an unrelated edit is the
same always-red gate by a slower route. The cost is that a second instance of an
already-accepted pattern in the same place would not register, so the count per
fingerprint is tracked too — one more `missing-zero-check` in a constructor that
already has one still fails.

**Both scanners are pinned**, to slither 0.11.5 and aderyn 0.6.8, the versions
the baseline was recorded against. A baseline is only meaningful against a fixed
scanner: a new version reports differently, which would arrive as a wall of new
findings and blow the baseline apart. Upgrading is a deliberate act — bump the
pin, re-triage, re-record. CI verifies aderyn's download against a sha256 taken
from the release and checked against the tarball rather than copied.

**Proven to bite.** An unused state variable was added to `ShieldedPool.sol` and
the gate went red with three new findings, from both scanners independently:

```
NEW — not in the baseline, nobody has read these yet:
  aderyn|unused-state-variable|src/ShieldedPool.sol  (x1)
  slither|constable-states|src/ShieldedPool.sol|variable _scratch  (x1)
  slither|unused-state|src/ShieldedPool.sol|variable _scratch  (x1)
```

The contract was then restored byte-identical. Baseline:
[`baseline.json`](baseline.json), 23 fingerprints over 32 instances.

### Before and after

The scan ran, three things were fixed, and it ran again. Both columns come from
`scan.sh`; the reports in this directory are the second run.

| | first scan | after the fixes |
|---|---|---|
| slither total | 34 | **15** |
| — High | 3 | 2 (both design, see below) |
| — Medium | 5 | **0** |
| — Low | 13 | 6 |
| — Informational | 12 | 7 |
| aderyn instances | 39 | **17** |
| — High issues | 2 | **0** |

Test baseline moved with it: **62 → 64**, the two new ones pinning the fix.

## Verdict

**Neither tool found a way to take money out of the pool.** After reading every
finding against the source, nothing rises to a defect that puts deposited value
at risk, and three items are worth fixing anyway.

That result is less reassuring than it sounds, and the reason is in
[what these tools cannot see](#what-static-analysis-cannot-see-here) at the
bottom. Every High reported here is a value movement whose safety lives in a
proof public input — which is precisely the thing neither tool models.

## The deployed bytecode is the published source

**Verified on Blockscout, 2026-08-02.** Before submitting anything, each
contract's locally built runtime bytecode was compared against what the chain
actually holds. That comparison is the real result; the explorer badge is just
where it is now visible.

| Contract | Address | Built from | Match |
|---|---|---|---|
| `ShieldedPool` mainnet | `0x6f98666e…6a3E` | **HEAD** | byte-identical, 13,427 B |
| `ShieldedPool` testnet | `0xf9F825f2…2A59` | **HEAD** | byte-identical, 13,427 B |
| `CowlTradeAdapter` mainnet | `0x0b86f9d1…3A98` | **`8b1c58f~1`** | identical but for its immutables |

Two things follow, and the second one is the useful one.

**The pool is a reproducible build.** Anyone with this repository and solc
0.8.35 gets the same 13,427 bytes that sit on mainnet, with no optimizer and no
special flags. That is a stronger statement than "verified": it means the source
in this tree is the source that holds the money, checkable without trusting
Blockscout, GitHub or us.

**The adapter's deployed commit is now pinned exactly.** L-01 and L-02 are fixed
in this repository and not on chain — recorded here since 2026-07-28 — and the
comparison turns that from a note into a measurement. HEAD builds to 6,614 bytes;
the chain holds 6,531; `8b1c58f~1` builds to 6,531 and differs from the chain
only where the `immutable` pool, router and WETH addresses are baked in at
construction. The diff lands at offsets 310 and 346 and reads
`6f98666e9d…6a3E` and `0Bd7D308f8…AD73` — the pool and WETH, exactly.

So the verified source on the explorer is the **pre-fix** adapter, which is what
is actually running. That is the honest artifact, and it is the one a bounty
researcher needs: [`../bounty/`](../bounty/README.md) K-2 and K-3 can now name a
commit rather than a caveat.

Blockscout's public API rate-limits hard from a single address. `forge
verify-contract` fails at its ABI pre-check long before it submits anything; a
direct `POST` to `/api/v2/smart-contracts/<addr>/verification/via/standard-input`
with `files[0]=@std.json;type=application/json` goes through. The explicit
content type is not optional — without it the endpoint answers
`JSON files not found`.

## Findings at a glance

Six findings on record. Severity follows the Impact × Likelihood matrix in
[`../README.md`](../README.md); raw tool severities stay in the raw output and
do not carry into this table unverified.

| ID | Finding | Severity | Status |
|---|---|---|---|
| [M-01] | Verifier-swap escape hatch had no watcher; owner is a single EOA | Medium | **Mitigated** — state watcher + recorded baseline ([`../monitoring/`](../monitoring/README.md)); scheduled runs and a multisig still open |
| [L-01] | Adapter refund `transfer` return value unchecked | Low | **Fixed in `8b1c58f`, and deliberately not deployed** — decided 2026-08-02; ERC-20 branch covered since 2026-08-01, both mutations caught |
| [L-02] | Adapter `approve` return values unchecked, 3 sites | Low | **Fixed in `8b1c58f`, and deliberately not deployed** — fails closed either way; pinned by failing-first tests |
| [I-01] | Adapter is a one-way sink: open `receive()`, no sweep | Informational | **Acknowledged** — holds funds for one transaction by design |
| [I-02] | A fee-on-transfer or rebasing token desyncs its own `pooledValue` | Informational | **Acknowledged** — per-token turnstile bounds the damage; a client-side warning is the fix |
| [I-03] | Tokens returning no value (USDT-shaped) cannot shield at all | Informational | **Acknowledged** — fails closed |

The fixes and the mock move landed together in `8b1c58f`, on top of audited
commit `1cbb48a`. The deployed adapter predates both — see the note below.

## Findings, and what was done

> **Fixed in source, not on chain.** All three lived in `CowlTradeAdapter.sol`,
> which is deployed immutable at `0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98` on
> mainnet, built from `8b1c58f~1` and verified there. The source now carries the
> fixes; **the deployed adapter does not, and that is a decision as of
> 2026-08-02** rather than an open item — the argument is above the findings
> table. Finding 1 was also
> never reachable with the tokens tradeable today: it fires only on a token that
> returns `false` instead of reverting, and the adapter can only route assets
> with a venue pool — WETH, the real USDG, COWL — all standard.
>
> **The repo therefore does not match the deployed adapter bytecode until the
> next adapter deploy**, which the swap work will require anyway. That is a known
> and accepted gap, recorded here so nobody discovers it by surprise during a
> source verification.
>
> The pool itself is untouched. `ShieldedPool.sol` has not changed.

### [L-01] Unchecked ERC-20 return on the adapter's refund — **fixed**, `CowlTradeAdapter.sol:199`

```solidity
IERC20Adapter(swapIn).transfer(msg.sender, left);
```

The only value movement in either contract whose return value is dropped. The
pool checks its own on both sides (`ShieldedPool.sol:264` deposit,
`ShieldedPool.sol:368` payout); the adapter does not check this one.

A token that returns `false` instead of reverting makes the refund silently
fail. `left` then sits in the adapter, and the adapter has no sweep function, so
it is stranded permanently.

Not a loss of user funds — `left` is the caller's own unspent surplus, and the
trade itself has already settled correctly by that line. Both tools flagged it
independently (slither `unchecked-transfer` High, aderyn L-8/L-9).

**Fixed** by reverting with `RefundFailed()` rather than skipping. Reverting is
the right call and not the obvious one: it kills an otherwise-settled trade over
a failed tip. But the contract's own promise is "revert anywhere and the trade
never happened", the adapter has no sweep, and by that line the same token has
already survived an `approve` and a router pull — so a `false` from `transfer`
means something is badly wrong, not that a tip is merely inconvenient. The
matching ETH branch already reverted; it now uses the same custom error instead
of a `require` string.

### [L-02] Unchecked `approve` returns — **fixed**, `CowlTradeAdapter.sol:148`, `:173`, `:182`

Same shape, but these fail closed: an `approve` that silently returns `false`
makes the router call or the `pool.shield` that follows it revert, taking the
whole trade with it. No value was at risk. Fixed anyway, with `ApprovalFailed()`,
for uniformity with the pool — which checks every one of its own.

**Both fixes are pinned by tests that fail without them.** `test/mocks/SilentFailToken.sol`
adds tokens that report failure by returning `false` instead of reverting — the
venue mocks all return `true`, which is exactly why 62 passing tests never
touched these paths. The two cases in `CowlTradeAdapter.t.sol` cover the
input-leg and shield-leg approvals, and both were confirmed to fail against the
pre-fix source before being kept.

**The ERC-20 refund at `:199` is now covered too**, by
`test/CowlTradeAdapterErc20Leg.t.sol` (2026-08-01). This entry previously called
it untestable until a proof fixture with an ERC-20 input leg existed. **That was
wrong, and the reason is worth keeping.** The fixture requirement came from the
end-to-end file's own shape, where the real verifier means `spend.token` can only
be whatever a fixture already committed to. But the proof is not what this branch
is about — the end-to-end file already proves the real verifier accepts these
calls and rejects tampered ones. Building the pool on an accepting verifier, the
way the invariant suite does, makes `spend.token` free while the turnstile, the
nullifier set and the root ring all stay real and still have to hold. **A missing
test was attributed to a missing fixture when it was really a missing test.**

Four cases: the surplus refund itself, the exact-fill boundary either side of
`left != 0`, `SameAsset` on a leg that can only be reached with an ERC-20 input,
and the silent failure that L-01 exists for. Reaching that last one needs a token
that fails for the adapter alone, since the pool's own payout on the same line is
also a `transfer` and would otherwise revert first — `SilentFailTransferForToken`
takes one address and fails only for it.

**Both mutations were run.** Dropping the return check reverts the fix, and
`test_a_silent_refund_failure_unwinds_the_whole_trade` fails with "next call did
not revert as expected". Removing the refund entirely also fails
`test_an_erc20_input_leg_refunds_its_surplus_to_the_submitter` on `0 != 100`.
Source restored and `git diff` clean after each.

### [I-01] The adapter is a one-way sink — acknowledged, `CowlTradeAdapter.sol:112`

`receive() external payable {}` is open and there is no rescue path. Combined
with finding 1, anything that lands in the adapter outside a settling trade —
a stray send, a stranded refund — is locked forever.

The adapter is designed to hold nothing between transactions and the ledger
below confirms it balances exactly, so this is about dust, not deposits. Noting
it because the pool has the same property deliberately (DIH and the lookalike
USDG already sit in it unwithdrawable) and both are permanent by design.

## Verified as design, not defects

Written out because "slither says High" will come up again, and the answer
should be on record rather than re-derived.

### `arbitrary-send-eth` in `ShieldedPool._payOut` — **not arbitrary**

```solidity
(bool ok,) = to.call{value: amount}("");
```

`to` is `s.recipient` or `s.relayer`, and both are bound into the proof as
public inputs (`ShieldedPool.sol:343`, `:344`). A caller cannot redirect a
payout without a proof that names the address they want it sent to. The pool
additionally refuses `value != 0` with a zero recipient (`:305`) and `fee != 0`
with a zero relayer (`:306`), so value can never be burned to `address(0)`.

Slither has no model of a proof, so every payout it sees looks caller-controlled.

**Reentrancy on this path is closed by ordering, and it is worth being explicit
about why.** Every effect lands before any interaction: nullifiers marked
(`:323`–`:324`), commitments marked (`:325`–`:326`), `pooledValue` debited
(`:327`), leaf index advanced (`:328`), root advanced (`:329`) — all of it
before `transferVerifier.verify` and long before `_payOut`. A recipient that
reenters `spend()` finds its nullifiers already spent.

### `arbitrary-send-eth` in `CowlTradeAdapter.trade` — bounded by the caller's own input

The surplus tip to `msg.sender` (`:188`, `:191`) is documented design: routing
change back toward the trader would draw exactly the link the adapter exists to
avoid. The question worth answering is whether it can be used to extract more
than the caller put in. It cannot — the adapter's ledger balances exactly:

| | in | out |
|---|---|---|
| unshielded leg | `maxIn` (from `pool.spend`) | `spent` (to router) |
| output leg | `amountOut` (from router) | `amountOut` (to `pool.shield`) |
| surplus | — | `left = maxIn - spent` |

Total in `maxIn + amountOut`, total out `spent + amountOut + (maxIn - spent)` =
`maxIn + amountOut`. `left` is capped by `maxIn`, which is the caller's own
unshielded value, so a caller can never claim more than they brought. A router
returning `spent > maxIn` underflows and reverts under 0.8.x.

### `timestamp` (3 instances) — one real, two false

`ShieldedPool.sol:194` (`block.timestamp < p.executeAfter`) gates a **7-day**
delay. Validator drift is seconds. The other two, both in
`CowlTradeAdapter.trade`, are slither taint artifacts: `left != 0` and
`require(ok, "tip failed")` are not timestamp comparisons at all.

### `reentrancy-events` (3), `pragma`/`solc-version`, `cyclomatic-complexity`

Events emitted after external calls, with no state read afterwards — cosmetic.
The pragma spread is between our `^0.8.27` and the `>=0.8.21` header bb writes
into its generated verifier; the actual compile is pinned by `foundry.toml`.
Complexity 12 on `shield` and 19 on `spend` is a count of guard clauses, which
is the point of both functions.

### `ShieldedPool` has no `receive()` or `fallback()` — checked, and good

ETH enters only through `shield`, where `msg.value == value` is enforced
(`:261`). The native side of the turnstile therefore cannot be desynced by a
plain send; only `selfdestruct` or a coinbase payment can force ETH in, and that
strands it harmlessly rather than inflating `pooledValue[0]`. Recording it as a
property that was verified, not assumed.

## Limits neither tool reports, found while triaging

Both of these come from the pool accepting **any** ERC-20 id permissionlessly —
there is no token allowlist, and the contract is immutable, so these are things
to document and warn about client-side rather than fix.

### [I-02] Fee-on-transfer and rebasing tokens break `pooledValue` for that token

`shield` credits `pooledValue[token] += value` (`:246`) and then pulls `value`
via `transferFrom` (`:264`). A token that delivers less than `value` leaves
`pooledValue` over-counting what the pool actually holds, and the last holders
of that token find it short on withdrawal.

**The blast radius is one token, and that is by design.** `outflow >
pooledValue[s.token]` (`:316`) is per token, so a broken or hostile token cannot
reach COWL, AAPL, USDG or ETH. The ZIP-209-style turnstile does exactly the job
it was put there for. Still worth stating plainly: a fee-on-transfer token
shielded today would strand its own depositors.

### [I-03] Tokens that return no value cannot be shielded at all

`IERC20` declares `transfer`/`transferFrom` as `returns (bool)`, so a USDT-style
token returning empty calldata reverts in the ABI decoder. This **fails closed** —
the deposit reverts, nobody loses anything — but it means such tokens are simply
unusable with the pool and the adapter. Worth a line in the docs rather than a
contract change.

## [M-01] Governance — the escape hatch, restated with the number

Aderyn L-1 flags the five `onlyOwner` functions. The finding is known; the
figure is what matters and is not in the report:

`proposeVerifierSwap` → wait `VERIFIER_SWAP_DELAY` (**7 days**) →
`executeVerifierSwap` installs a verifier that accepts anything. `ExceedsPooledValue`
then caps a drain at all of `pooledValue`, which is everything. **The 7-day
window is the entire defence, and nothing currently watches
`VerifierSwapProposed`.** Owner was a single deployer EOA when this was written.

**Both halves are closed as of 2026-08-02.** A watcher runs every 15 minutes from
the VPS and tells a person, and **ownership of both pools now sits with a 2-of-3
Safe** at `0x708c36A9A54FfbFd16130eF0D9F7F581b90054f3` — mainnet in
`0xff7a9f94…f627f`, testnet the day before.

The single deployer EOA no longer reaches the hatch. It cannot propose a swap, it
cannot execute one, and — the part that is easy to miss — **it cannot renounce**,
which was a one-transaction way to destroy the escape hatch outright with no
delay to notice it in.

What the delay still guards is a compromise of two of the three keys. That is the
residual, and it is why the 7-day window and the watcher both still matter.
Runbook and rehearsal: [`../../deploy/multisig/`](../../deploy/multisig/README.md).

Renouncing is not the answer while the verifier is unaudited — it would freeze
an unaudited verifier permanently. The two things that shrink this are a
monitor on the proposal event (audit plan Step 3) and moving ownership to a
multisig (Step 6). This finding is the strongest argument for doing Step 3
before the rest of the tooling work.

To be exact about what that monitor is, since it is easy to confuse with the
thing it watches: it is an off-chain watcher on public state. **No contract
change, no redeploy, nothing touching the verifiers themselves.** Actually
swapping a verifier is a separate act and is not proposed here — the swap path
stays untouched while the trade work is in flight.

**Built, and it now covers this.** `npm run watch` reads `pendingSwap()` and both
verifier addresses against a committed baseline, so a proposal *and* an already
executed swap both raise an alert. It also checks `pooledValue` against real
balances per token. Baseline, response playbook and what is still missing:
[`../monitoring/README.md`](../monitoring/README.md). The remaining gap is that
nothing runs it on a schedule yet.

## Noise attribution — **resolved**

In the first scan, `TestVenue.sol` was testnet scaffolding living in `src/`, so
it compiled and scanned alongside the production contracts. It accounted for:

- **12 of 34** slither results, including both `locked-ether` Mediums
- **18 of 39** aderyn instances, including **both** of aderyn's High issues
  (`H-1` and `H-2` were entirely `TestVenue.sol`)

Roughly 40% of the first report was scaffolding. It has been moved to
`contracts/test/mocks/TestVenue.sol` and `scan.sh` now targets the two
production contracts only.

**Nothing about the testnet venue changed** — the contracts are already deployed
on 46630 and `script/DeployVenue.s.sol` still builds and deploys them from the
new path, so the trade work that depends on them is untouched. Only three import
lines moved.

This mattered on a deadline rather than as a cleanup: it had to land **before**
CI gates on these scanners, or the gate would be born 40% noise and people would
learn to ignore it. A scanner nobody reads is not a control.

## What static analysis cannot see here

Stated so no one reads a clean scan as a clean protocol:

- **Neither tool models the circuit.** The bug class that can empty the pool is
  an under-constrained Noir circuit, and no Solidity linter reaches it.
- **Neither tool knows a public input is a public input.** Every High in this
  report is a value movement whose safety lives in the proof. The tools flag the
  movement and cannot see the binding, which is why the triage above is longer
  than the findings.
- **Neither tool reasons about call ordering across a sequence.** The six pool
  invariants in `AUDIT-PLAN.md` — nullifier uniqueness, `pooledValue` never
  exceeding balance, monotonic `nextLeafIndex` — are properties over arbitrary
  call orders. Concrete tests cannot reach them and static analysis does not try.
- **The generated verifiers were not scanned at all**, by choice. Their
  correctness is a barretenberg question, not a linting one.

This is the floor, not the ceiling. Six findings are on record — two fixed in
source with failing-first tests behind them, one mitigated by the monitoring
build-out, three acknowledged with their reasons written down — and the standing
noise dropped by more than half, so the next run is worth reading. None of that
could have found a drain. The work that can is the invariant suite and the
circuit harness, and neither has been written.
