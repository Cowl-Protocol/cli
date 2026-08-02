# Bounty — the paid program, drafted

**Draft. Nothing here is live and no vault is funded.** Audit plan Phase 4 has
four rows and no artifact behind any of them; this is the document all four
need before any of them can start, written so the only thing left is a number.

[`../../SECURITY.md`](../../SECURITY.md) is the unpaid policy and it is already
published: how to report, what we commit to, what is in and out of scope, and
the rules for good-faith testing. It says *"we do not currently run a paid
bounty. If that changes it will be announced rather than negotiated per
report."* This file is what changing it looks like, and none of it contradicts
that page — it adds money and a platform on top of a policy that already stands.

## What a bounty buys here, and what it does not

The pool is **immutable**. Not a proxy, no admin key over its logic, no pause.
A finding in `ShieldedPool.sol` itself cannot be patched: the response is a new
pool and a migration, run in public while the old one still holds money.

That single fact changes the economics in both directions, and a program that
does not say so out loud will be priced wrong.

| Where the bug is | Can it be fixed in place? | So a report buys |
|---|---|---|
| Noir circuit / a verifier | **Yes** — a 7-day timelocked verifier swap | a fix, with a week of exposure while it lands |
| `ShieldedPool.sol` | **No** | warning, and the time to get depositors out |
| `CowlTradeAdapter.sol` | Yes — it is redeployable and holds funds for one transaction | a fix |
| CLI, app, relayer | Yes — a publish or a restart | a fix |

For the second row a bounty is not buying a patch. It is buying the difference
between finding out from a researcher and finding out from a drained pool, and
that difference is the whole of `pooledValue`. Price the critical tier against
that, not against what a fix would have cost.

## What is actually at risk today

Read from mainnet on 2026-08-01, and the same numbers the turnstile watch holds
to the wei:

| Token | In the pool |
|---|---|
| ETH | 0.004353955809083422 |
| COWL | 4,294,818.91 |
| AAPL | 0.01073730 |
| USDG | 3.97 |
| — | 368 leaves in the tree |

**COWL is the pool**, in any honest reading of that table. Two consequences the
program has to be built around rather than around a dollar figure:

1. A vault denominated in COWL is not a workaround for having no cash. It is
   the correct denomination — it pays out in the same asset an attacker would
   have taken, so the reward tracks the risk automatically as the pool grows.
2. The pool is small **today**. A tier table fixed at today's balance is wrong
   the first week the pool is not small, so the tiers below are written as
   percentages with a floor, not as constants.

## In scope, with the commit that is being audited

A report against an unnamed commit cannot be traced to a fix, which is the rule
[`../README.md`](../README.md) already enforces on every internal report.

| Asset | Where | At |
|---|---|---|
| `ShieldedPool.sol` | mainnet `0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E` · testnet `0xf9F825f2D6d8509c78baaa587694f74672C32A59` | deployed, immutable |
| `CowlTradeAdapter.sol` | mainnet `0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98` · testnet `0xD0D74be38C0B99EBa6465e9F512c3F78EE2d1f3B` | **deployed build predates L-01/L-02** — see known issues |
| Shield verifier | mainnet `0x0D6E2e89…065fC` · testnet `0xB75c5659…0ba9` | generated, on chain |
| Transfer verifier | mainnet `0x18670646…1275E` · testnet `0xBA945Bf3…4239` | generated, on chain |
| Noir circuits | `circuits/{notes,shield,transfer}` | the commit the program names |
| `@cowlprotocol/cli` | npm, and `src/` in this repository | the published version at launch |
| Browser client | `Cowl-Protocol/app` | the commit the program names |
| Gasless relayer | `relay.cowlprotocol.com`, `src/relayer/` | the running build |

The verifier addresses are given in full in
[`../monitoring/pool-baseline.json`](../monitoring/pool-baseline.json), which is
also what the watch compares against.

## Severity, and why it is not the platform's default table

[`../README.md`](../README.md) already defines severity as Impact × Likelihood,
with impact measured **against deposited value first, availability second**.
Every internal report uses it. A program that adopts a platform's generic table
would grade the same finding two different ways depending on where it was
reported, so the internal scale is the one that governs and the platform's
labels map onto it.

| Tier | What it takes | Suggested reward |
|---|---|---|
| Critical | value leaves the pool that did not enter it, a forged proof verifies, or a nullifier can be reused — anything that reaches `pooledValue` | % of the value made recoverable, floor and cap below |
| High | a spend can be redirected, censored permanently, or a user's link between deposit and withdrawal is recoverable from public data | fixed |
| Medium | the relayer can be made to overcharge, deny a token, or be driven off; the adapter can be made to lose value bounded by one transaction | fixed |
| Low / Informational | everything the matrix does not reach | credit, and a listing in this tree |

**Privacy findings belong at High and this is the row people get wrong.** Cowl's
product is that a deposit cannot be linked to a withdrawal. A finding that
breaks that link steals nothing and is worth more than several findings that
move dust — any program that only prices "funds at risk" will be told about the
dust and not about the linkage.

### The three numbers this document cannot decide

1. **Vault size.** How much COWL sits behind the program.
2. **Critical percentage and cap.** Standard practice is 10% of value at risk;
   the immutability argument above is a reason to sit above standard rather than
   below it.
3. **The floor.** A percentage of a small pool is a rounding error, and a
   critical-tier reward that does not clear what a competent auditor charges for
   a week is not a program, it is a formality. The floor is what makes the tier
   real while the pool is still growing.

They belong to whoever holds the creator-fee stash. Everything else here is
ready.

## Known issues, declared

**A program that does not publish its known issues pays twice for them.** Every
🟡 in this tree is listed here, and each one is already argued in full in the
report it links to. A researcher who reports one of these gets the reasoning
back, not a payout — and that is only fair if they could read it first.

| # | Known | Status | Where it is argued |
|---|---|---|---|
| K-1 | Verifier swap is the pool's one escape hatch, behind a 7-day delay | **Closed** — held by a 2-of-3 Safe since 2026-08-02, watched every 15 minutes. Residual: compromise of two of three keys | [`../static/`](../static/README.md) M-01 |
| K-2 | Adapter refund `transfer` return unchecked | Fixed in source; **the deployed build is `8b1c58f~1`, proven by bytecode comparison and verified on the explorer** | [`../static/`](../static/README.md) L-01 |
| K-3 | Adapter `approve` returns unchecked, 3 sites | Same commit; fails closed either way | [`../static/`](../static/README.md) L-02 |
| K-4 | Adapter is a one-way sink | Acknowledged, holds funds for one transaction by design | [`../static/`](../static/README.md) I-01 |
| K-5 | Fee-on-transfer tokens desync their own `pooledValue` | Acknowledged, bounded per token by the turnstile | [`../static/`](../static/README.md) I-02 |
| K-6 | USDT-shaped tokens cannot shield | Acknowledged, fails closed | [`../static/`](../static/README.md) I-03 |
| K-7 | Two input slots need not be different notes in circuit | Acknowledged, the pool's `RepeatedNullifier` holds it | [`../circuits/`](../circuits/README.md) I-01 |
| K-8 | `shield` does not range-check `value` in circuit | Acknowledged, needs a token with 3.4e38 supply; stuck, not stealable | [`../circuits/`](../circuits/README.md) I-02 |
| K-9 | The relayer's ERC-20 fee floor is a bound between tiers, not a proof any tier is honest | Residual named | [`../relayer/`](../relayer/README.md) R-01 |
| K-10 | An attacker who can move a price can make a token unquotable | Residual named — costs the relayer nothing, drops that token to self-paid | [`../relayer/`](../relayer/README.md) |
| K-11 | Tokens sent by plain transfer sit at `pooledValue` 0 and are unwithdrawable by anyone | Expected, deliberate | [`../monitoring/`](../monitoring/README.md) |

K-2 and K-3 are the two to watch when the program launches. They are **fixed in
this repository and not on chain**, so a researcher reading `main` sees code that
differs from the deployed adapter.

**Half of that is now closed.** All three contracts are verified on Blockscout as
of 2026-08-02, and the adapter was verified from `8b1c58f~1` — the commit that
actually built the deployed bytecode, established by comparison rather than by
memory. A researcher reading the explorer therefore sees the real thing, and this
document can name a commit instead of a caveat.

What is left is the decision, not the ambiguity: **redeploy the adapter, or
declare the deployed build as the in-scope artifact.** Either is defensible.
Launching without picking one still invites a valid report against a fix that
already exists.

## Platform

| Platform | Model | Fits | Against |
|---|---|---|---|
| **Hats Finance** | vault funded in the project's own token, permissionless launch, rewards vest | pool + circuits | audience is smaller than Immunefi's; a token-denominated payout is worth what the token is worth on the day |
| Immunefi | pay per valid report, 45,000+ researchers | everything | needs cash or a stable, and a listing process |
| Sherlock | researchers stake $250 per report | contracts | the stake filters noise, but it is a contest format on a schedule |
| CodeHawks First Flights | prize pool under $20k | adapter, boundary | entry level — wrong venue for the circuits |
| Code4rena / Cantina | prize pool up front | contracts | cash up front |

**Hats first, and it is not close.** The vault funds from the creator-fee stash
instead of from cash, the launch does not wait for a slot, and the vesting is
what stops a payout becoming a sell. The plan already said as much and nothing
found since argues otherwise.

What Hats does not cover is the circuits, and that gap is real: **no free tool
audits a Noir circuit**, and the researcher pool that reads Noir under-
constraint bugs is small enough that a permissionless vault may simply not
attract one. The route for that is the Aztec grant in the plan's Phase 4, paying
a firm that does ZK — Veridise, Zellic, zkSecurity — and it runs in parallel
rather than after.

Cowl is a Noir protocol in production carrying real value, which is the exact
profile those grants exist for. The application needs this document, the audit
tree it links to, and the numbers above.

## Launch checklist

Each of these is a thing to do, not a thing to decide, except where marked.

- [ ] **Decide** the vault size, the critical percentage and cap, and the floor
- [ ] Redeploy the trade adapter, or name the deployed bytecode as in scope and
      say the source is ahead — K-2 and K-3
- [ ] Name the exact commit in every repository the program covers
- [ ] Publish this file's scope and known-issues tables on the platform, verbatim
- [ ] Point [`../../SECURITY.md`](../../SECURITY.md) at the program, replacing
      the "we do not currently run a paid bounty" line
- [ ] Confirm the response times in `SECURITY.md` are ones a human can hold to
      under a live report — 72 hours to acknowledge, 7 days to assess
- [ ] Decide who is reachable if a critical arrives at 3am, and how. The pool has
      no pause; the levers are stopping the relayers and telling people to
      withdraw, and both need a person
- [ ] File the Aztec grant application for a circuit review, in parallel

The last two are the ones that turn a program from a page into a control. A
bounty is a promise that somebody is on the other end of it.
