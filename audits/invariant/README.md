# Invariant suite — `ShieldedPool.sol`

**Date** 2026-07-29 · **Audited commit** `5eb31a8` · **Tool** Foundry 1.7.1
(`forge` invariant fuzzer) · **Scope** `src/ShieldedPool.sol`

**Outcome.** The six pool invariants held across **245,760 calls** (six
properties × 256 runs × depth 160) in randomised order, with the proof system
stubbed to accept everything. Every invariant is proven capable of failing:
six mutations of the pool, one per defence, were each caught by the invariant
that names that defence. Two assumptions the pool inherits from the circuits
rather than re-deriving are recorded below as informational; neither is
reachable through a sound verifier.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Check | Result |
|---|---|---|
| 🟢 | 1 · `pooledValue` never exceeds the balance behind it | held, 40,960 calls |
| 🟢 | 2 · a nullifier is never accepted twice | held, 40,960 calls |
| 🟢 | 3 · a commitment is never inserted twice | held, 40,960 calls |
| 🟢 | 4 · outflow never exceeds inflow, per token | held, 40,960 calls |
| 🟢 | 5 · leaf index accounts for every inserted leaf | held, 40,960 calls |
| 🟢 | 6 · every retained root stays retrievable | held, 40,960 calls |
| 🟢 | The suite can fail | 6 pool defences deleted one at a time, 6 caught |
| 🟢 | The handler actually reaches the pool | pinned by a fixed sequence, not by `afterInvariant` |
| 🟡 | I-01 · the root ring assumes distinct roots | acknowledged, unreachable through a sound verifier |
| 🟡 | I-02 · a root of zero is never evicted | acknowledged, same |

**Nothing here reaches deposited funds.** Both 🟡 items are properties the pool
inherits from the circuits without restating them, which is only visible because
this suite removes the circuits. Closing either costs a storage slot on every
insertion, forever, on an immutable pool.

Reproduce:

```
npm run test:invariant     # the suite
npm run test:mutants       # proves the suite can fail
```

## Why this phase exists

The [static pass](../static/README.md) reads the code. A concrete test fixes the
order it calls things in, and call ordering is exactly what an accounting bug
hides behind — the drain that no single transaction commits and no single test
reaches. These six properties are stated so they must hold after *every* call in
*any* order.

## The verifier is stubbed to accept everything, deliberately

Every proof in this suite verifies. The handler may therefore claim any note,
any root, any amount, in any sequence — the posture of an attacker who has
already broken the circuits completely.

What survives that is the pool's own defence, and nothing else: the per-token
turnstile, the nullifier and commitment maps, the field checks, the leaf bound.
That is the property worth proving, because it is the one that does not need a
circuit review to be believed. It is the same reasoning behind the turnstile
itself, which `ShieldedPool.sol` models on Zcash's ZIP-209 and describes as the
last line of defence precisely because it is independent of proof soundness.

The cost is that the handler reaches states an honest client never would. Where
that matters it is named at the call site rather than quietly avoided, and the
two places it produced a real observation are written up below.

## The six invariants

| # | Property | Test |
|---|---|---|
| 1 | `pooledValue[token]` never exceeds the balance actually behind it | `invariant_pooled_value_never_exceeds_the_balance_behind_it` |
| 2 | A nullifier is never accepted twice | `invariant_a_nullifier_is_never_accepted_twice` |
| 3 | A commitment is never inserted twice | `invariant_a_commitment_is_never_accepted_twice` |
| 4 | Cumulative outflow per token never exceeds cumulative inflow for that token | `invariant_outflow_never_exceeds_inflow_per_token` |
| 5 | `nextLeafIndex` accounts for exactly the leaves inserted, and stays inside the tree | `invariant_leaf_index_accounts_for_every_inserted_leaf` |
| 6 | Every root the pool advances to stays retrievable while the ring retains it | `invariant_recent_roots_stay_retrievable` |

Two of these are stronger than the plan asked for, and the difference is where
the value is:

**Invariant 1 is written as "never exceeds", not "equals".** Value can reach the
pool without a deposit: there is no `receive()` and no `fallback()`, but
`selfdestruct` lands regardless. The handler force-feeds native value on purpose
to keep that path exercised. The dangerous direction is the other one, an
accounting entry with no asset behind it, and that is the direction the
assertion is written to catch.

**Invariant 5 is an equality against a shadow count, not plain monotonicity.**
The plan asked that `nextLeafIndex` only increase. The damaging failure is not a
rewind, it is a *stall*: an index that fails to advance hands the next insertion
a position the tree already occupies, and a monotonicity check reads that as
perfectly fine. The handler counts one leaf per accepted deposit and two per
accepted spend, and the invariant requires the pool's counter to match exactly.
The `leaf-stall` mutant below is caught by that equality and would survive plain
monotonicity.

**Invariant 4 is not a restatement of the turnstile.** The turnstile checks one
spend against a running balance. Invariant 4 is the claim over the entire
history, which is what actually matters, because a drain is a sequence and not a
call. The `turnstile` mutant demonstrates the gap: with the check removed, the
pool can still pay out force-fed value that no depositor ever put in, leaving
invariant 1 satisfied and invariant 4 violated.

## Proving the suite can fail

A green invariant suite proves nothing on its own. An invariant that no mutation
of the code it guards can violate is testing nothing at all.

`mutants.sh` breaks the pool on purpose, one defence at a time, and requires the
paired invariant to catch it. The source is edited in place and restored by a
trap, including on interrupt.

| Mutant | The defence it removes | Caught by |
|---|---|---|
| `double-credit` | `shield` credits `value * 2` to `pooledValue` | invariant 1 |
| `turnstile` | the `ExceedsPooledValue` check, and the checked subtraction made `unchecked` | invariant 4 |
| `nullifier-reuse` | the `AlreadySpent` check in `spend` | invariant 2 |
| `commitment-reuse` | the `DuplicateCommitment` check in `spend` | invariant 3 |
| `leaf-stall` | `nextLeafIndex` advances by 1 instead of 2 | invariant 5 |
| `root-forgotten` | `knownRoot[r] = true` in `_rememberRoot` | invariant 6 |

**6/6 caught.** A survivor would mean the invariant does not constrain the code
it names, and the script exits nonzero on one.

The `turnstile` mutant needed two edits rather than one, and the reason is worth
recording: **removing the check alone does not drain the pool**, because
`pooledValue[s.token] -= outflow` is itself checked arithmetic and reverts on
underflow. The explicit check and the subtraction are two independent guards on
the same property, and the ERC-20 transfer is a third. Modelling the
pre-turnstile design required disabling two of them.

## Observations

Both are informational and neither is a vulnerability. Both are properties the
pool leans on the circuits to supply without restating them, which is only
visible because this suite removes the circuits.

### [I-01] The root ring assumes the roots it is handed are distinct

`_rememberRoot` clears `knownRoot[evicted]` when a slot is overwritten. If the
same root value occupies two ring slots, evicting the older copy clears the flag
for the newer one, and a root still inside the 32-entry window reports as
unknown. Spends proven against it then revert with `UnknownRoot`.

**Impact** Availability of one root, for one window. No effect on funds.

**Reachability** None through a sound verifier. `newRoot` is constrained
in-circuit as the result of inserting a specific leaf at a specific index, so two
insertions produce the same root only if Poseidon2 collides.

**Status** Acknowledged. Pinned by `test_a_repeated_root_is_evicted_early`, which
fails if the behaviour ever changes shape.

### [I-02] A root of zero is never evicted

Eviction skips the zero slot, which is how the ring distinguishes an unused entry
from a real one. A root of zero is therefore never cleared and stays spendable
permanently, long after the window that should have retained it.

**Impact** Root history is unbounded for exactly one value. Exploiting it still
requires producing a valid membership proof against root zero.

**Reachability** None through a sound verifier: reaching root zero means finding
a Poseidon2 preimage chain to zero. Closing it costs a storage slot per
insertion to mark occupancy, against a consequence already bounded by the same
soundness assumption the rest of the pool rests on.

**Status** Acknowledged. Pinned by `test_a_zero_root_is_never_evicted`.

## Notes for whoever runs this next

**`fail_on_revert` is off, and that needs a guard.** The handler is *meant* to be
told no: it replays burned nullifiers, asks the turnstile for more than a token
holds, and proves against evicted roots. A revert is the pool working. The price
is that a handler which reverted on every single call would satisfy all six
invariants without touching the pool, and the run would be green and worthless.

**The guard is a concrete test, not `afterInvariant()`, and this was measured.**
On forge 1.7.1 the handler state visible from `afterInvariant` is not the state
the campaign built: running this file, five of the six invariants saw every
counter at zero while the sixth saw 26 deposits and 26 spends, from the same
handler in the same run. `HandlerReachesThePool` drives a fixed sequence and
asserts each action lands, which proves the same thing and cannot drift with a
fuzzer seed or a Foundry release.

**Depth 160, not the default.** At depth 64 a sequence never produced more than
about 31 roots, so the 32-entry ring never wrapped, and the stale-root action
returned early on every call — a whole branch of the handler was dead and the
run still passed. `test_an_evicted_root_is_refused` now pins that the branch is
reachable.

**Per-run coverage** at depth 160, from a representative sequence: 34 deposits
accepted, 24 spends accepted, 7 turnstile refusals, 41 replay refusals, 2
stale-root refusals, 82 leaves inserted.

## Files

| Path | What it is |
|---|---|
| `contracts/test/ShieldedPoolInvariants.t.sol` | the six invariants, the ring-assumption tests, the coverage guards |
| `contracts/test/PoolHandler.sol` | the handler and its shadow ledger |
| `contracts/foundry.toml` | `[invariant]` runs, depth, and why `fail_on_revert` is off |
| `audits/invariant/mutants.sh` | the mutation harness |
