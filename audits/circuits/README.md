# Circuit adversarial harness — `transfer` and `shield`

**Date** 2026-07-29 · **Audited commit** `26511b2` · **Tool** nargo 1.0.0-beta.22
· **Scope** `circuits/transfer/src/main.nr`, `circuits/shield/src/main.nr`,
`circuits/notes/src/lib.nr`

**Outcome.** Every constraint in both circuits is now covered by a test that is
proven to depend on it: **17 constraints deleted one at a time, 17 caught**. The
circuits are unchanged — this phase added tests and found no missing constraint
in the spend path. Two properties the circuits do not enforce are recorded below
with the reason each is safe as deployed, and the public-input binding that no
Noir test can reach is covered by a separate cross-check against the pool.

Tests: transfer 12 → **23**, shield 4 → **6**, notes 3.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale defined in
[`../README.md`](../README.md).

| | Check | Result |
|---|---|---|
| 🟢 | Value conservation, in the field and at its edges | held; wraps blocked by the range checks on every leg |
| 🟢 | Input membership under a remembered root | held |
| 🟢 | Leaf index tied to the position the path proves | held — the double-spend this would otherwise open |
| 🟢 | Nullifier derived from the spending key and that leaf | held |
| 🟢 | Output leaf bound to the note it claims to be | held — the mint this would otherwise open |
| 🟢 | Outputs append in order, to the tree the chain has | held |
| 🟢 | `new_root` is what the insertions produce | held |
| 🟢 | What leaves matches the asset the notes hold | held |
| 🟢 | Chain id, recipient and relayer survive compilation | held; 14 of `spend` and 6 of `shield` match the pool position for position |
| 🟢 | The tests can fail | 17 constraints deleted one at a time, 17 caught |
| 🟡 | I-01 · two input slots need not be different notes | acknowledged, the pool's `RepeatedNullifier` holds it |
| 🟡 | I-02 · `shield` does not range-check `value` | acknowledged, needs a token with 3.4e38 supply; stuck, not stealable |

**No missing constraint was found, and the circuits were not changed.** Nine
constraints had no test that isolated them before this phase; all nine turned out
to be enforced correctly. Both 🟡 items would cost a 7-day timelocked verifier
swap on an immutable pool to close.

```
npm run test:circuits          # all three packages
npm run test:circuit-mutants   # proves the tests can fail
npm run test:publicinputs      # circuit public inputs vs the pool's
```

## Why the plan's version of this step was not the work

The audit plan describes this step as giving the existing `#[test]` functions
arguments so `nargo` fuzzes them. That was renamed and rescoped, deliberately.

Fuzzing the inputs of `main` demonstrates that **valid witnesses are accepted**.
It cannot find the bug that empties a shielded pool, which is the opposite one: a
circuit that **accepts a witness it should reject** because a constraint everyone
assumed was there is missing. A random witness fails the membership check long
before it reaches anything interesting, so a fuzzer spends its whole budget
re-confirming that garbage is garbage.

What finds an under-constrained circuit is a witness that is perfect in every
respect except one, aimed at exactly one constraint. That is what this harness
builds.

## The method

Every adversarial test starts from `honest()` — a complete, valid spend — bends a
single field, and repairs anything downstream that the bend invalidated. Two
helpers do the repairing: `recommit` rebuilds the output commitments from the
output notes, and `reseal` rebuilds the append paths and the new root. Without
them a test would deviate in two places at once and could pass for the wrong
reason.

`the_adversarial_baseline_is_a_valid_spend` asserts the starting point is
accepted. Without it, every `should_fail` below would prove nothing: a witness
that was already invalid gets rejected whatever the circuit does with the field
under test.

## Proving the tests can fail

`mutants.mjs` deletes one constraint and requires the paired test to notice. With
the constraint gone the adversarial witness becomes fully valid, the
`should_fail` test passes unexpectedly, and nargo reports that as a failure.

Two guards make the verdict trustworthy:

1. **Only the circuit is mutated, never the tests.** The file is split at the
   first `#[test` and the substitution is applied to the head alone, so a pattern
   cannot reach a `should_fail_with` string and quietly change what a test
   expects. A pattern that matches anything other than exactly one site is an
   error, not a silent skip.
2. **The honest baseline must survive each mutation.** A mutation that broke
   compilation would also turn the paired test red, and would otherwise be scored
   as a catch.

| Mutant | Constraint deleted | Caught by |
|---|---|---|
| `in-range` | input value ≤ 2^128 | `an_input_cannot_wrap_the_field_to_fake_its_value` |
| `membership` | input note is under `membership_root` | `cannot_spend_a_note_that_is_not_in_the_tree` |
| `leaf-index` | `in_leaf_index` is the position the path proves | `a_real_input_cannot_nullify_a_position_it_never_proved` |
| `nullifier` | nullifier is the one this key produces | `a_nullifier_must_be_the_one_this_key_produces` |
| `out-range` | output value ≤ 2^128 | `output_value_cannot_wrap_the_field` |
| `out-commitment` | output leaf is bound to its note | `an_output_note_cannot_be_worth_more_than_it_accounts_for` |
| `append-root` | outputs chain from the current tree | `outputs_must_append_to_the_current_tree` |
| `append-order` | outputs land at `insert_index + j` | `outputs_cannot_land_anywhere_but_the_index_the_chain_named` |
| `new-root` | `new_root` is what the insertions produce | `the_new_root_must_be_the_one_the_insertions_produce` |
| `public-range` | `public_value` ≤ 2^128 | `the_public_leg_cannot_wrap_the_field_to_mint_change` |
| `fee-range` | `fee` ≤ 2^128 | `the_fee_cannot_wrap_the_field_to_mint_change` |
| `asset-binding` | what leaves is the asset the notes hold | `a_paid_send_cannot_hide_its_asset` |
| `conservation` | `sum_in == sum_out + public_value + fee` | `send_cannot_mint_value` |
| `shield-commitment` | commitment well-formed | `wrong_blinding_fails` |
| `shield-old-root` | insertion is against the chain's tree | `cannot_insert_against_a_tree_the_chain_does_not_have` |
| `shield-new-root` | `new_root` follows from the insertion | `cannot_claim_an_unrelated_new_root` |
| `shield-leaf-index` | `leaf_index` is what the path reaches | `cannot_claim_a_leaf_index_the_path_does_not_reach` |

**17/17 caught**, in 13 seconds.

## The two constraints worth naming

Nine constraints had no test that isolated them before this phase. Both circuits
turned out to enforce all of them correctly, so nothing here is a vulnerability.
Two are worth writing down anyway, because they are the ones where a missing
line would not look like a bug.

**`leaf-index` is a double-spend.** Membership is proven from the sibling path.
The nullifier is computed from `in_leaf_index`. If those two are not tied
together, a spender proves membership of the note at leaf 0 and publishes the
nullifier for leaf 5, then comes back and publishes leaf 6, then leaf 7. One
note, unlimited spends, every proof valid. The constraint exists
(`main.nr:104`); until now nothing tested it, and the test that does had to
supply the *matching* nullifier for the fake index, or it would have failed on
the nullifier check instead and proven nothing.

**`out-commitment` is a mint.** Conservation is checked over `out_value`. The
leaf that actually enters the tree is `out_commitments[j]`. Bind the two or the
accounting sees 60 leaving while the note deposited in the pool is worth a
billion. The constraint exists (`main.nr:118`).

## The public-input binding, which no Noir test can reach

`transfer` holds `recipient`, `relayer` and `chain_id` in the constraint system
with one line:

```noir
let payout_tag = Poseidon2::hash([recipient, relayer, chain_id], 3);
assert(payout_tag != 0);
```

That assertion is true for essentially every input, so it pins no value, and a
Noir test cannot show it doing anything. Its job is different: it makes the three
wires participate so the compiler cannot optimise them out. The binding itself
comes from the verifier checking the proof's public inputs against what the pool
passes — which only works if both sides agree on how many there are and in what
order.

A dropped input is loud: the counts stop matching and every proof fails. **A
swapped pair is silent**, and the verifier would check a recipient against a
relayer. Nothing else in this repository compared the two sides.

`publicinputs.mjs` now does. It flattens the compiled ABI's public parameters the
way the verifier sees them, reads the `publicInputs[i] = …` assignments out of
`ShieldedPool.sol` with the casts stripped, and checks both against a reviewed
pairing table: 14 for `spend`, 6 for `shield`. It was verified to bite by
swapping `recipient` and `relayer` in the pool and confirming it reports both
positions, after which the contract was restored byte-identical.

## Observations

Neither is a vulnerability. Both are places where the property holds for the
system while the circuit alone does not carry it.

### [I-01] The circuit does not require the two input slots to be different notes

Both input slots can point at the same leaf. Membership holds twice, both slots
nullify to the same value, and conservation sees 200 come out of a note worth
100. The circuit accepts this.

`ShieldedPool.spend` refuses it: `nullifiers[0] == nullifiers[1]` reverts with
`RepeatedNullifier` before the verifier is called at all.

**Impact** None as deployed. If that contract check were removed or reordered
behind the verifier call, it is a mint.

**Status** Acknowledged, and pinned by
`one_note_can_fill_both_input_slots_and_only_the_pool_says_no` — a passing test
whose name says which half of the system holds the property.

### [I-02] `shield` does not range-check `value`, `transfer` does

Every input value in a spend is range-checked to 128 bits. A deposit is not
checked at all. A deposit above 2^128 therefore mints a note that no spend can
ever consume, because the spend circuit would reject it as an input.

**Impact** Funds stuck, not stealable, and only for the depositor who did it.
Reaching it needs a token whose supply exceeds 2^128 ≈ 3.4e38 base units, far
above anything the pool holds — the largest position today is COWL at 1.4e25.

**Status** Acknowledged. Pinned by
`a_deposit_larger_than_the_spend_range_check_is_accepted_here`, which asserts the
current behaviour so that adding the check later reads as a decision rather than
as a line someone lost.

## What this phase does not cover

**No free tool audits a Noir circuit**, and this harness does not change that. It
proves that the constraints which are written are load-bearing and that the
adversarial cases anyone thought to write are genuinely adversarial. It cannot
prove that the set of constraints is complete — that a missing constraint nobody
imagined does not exist. That gap is what an external circuit review buys, and it
is why the audit plan keeps Veridise, Zellic and zkSecurity on the list and an
Aztec grant as the funding route.

## Files

| Path | What it is |
|---|---|
| `circuits/transfer/src/main.nr` | the adversarial harness section, after the original tests |
| `circuits/shield/src/main.nr` | the leaf-index test and the range-check observation |
| `audits/circuits/mutants.mjs` | the mutation harness |
| `audits/circuits/publicinputs.mjs` | circuit ABI against the pool's public inputs |
