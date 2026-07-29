#!/usr/bin/env bash
#
# Proves the invariant suite can fail.
#
# A green suite is worth nothing on its own: an invariant that cannot be
# violated by any mutation of the code it guards is testing nothing. This script
# breaks the pool on purpose, one defence at a time, and requires the matching
# invariant to catch it. A mutant that survives is a hole in the suite, and the
# script exits nonzero when it finds one.
#
# The source file is edited in place and restored by a trap, including on
# interrupt. Nothing here touches deployed bytecode.
#
#   ./audits/invariant/mutants.sh          # every mutant
#   ./audits/invariant/mutants.sh turnstile  # one, by name
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/../../contracts" && pwd)"
POOL="$CONTRACTS/src/ShieldedPool.sol"
# Spelled with an explicit directory rather than `mktemp -t`, which means
# different things to BSD and GNU mktemp and so behaves differently on a laptop
# and on a CI runner.
BACKUP="$(mktemp "${TMPDIR:-/tmp}/ShieldedPool.sol.orig.XXXXXX")"

cp "$POOL" "$BACKUP"
restore() { cp "$BACKUP" "$POOL"; rm -f "$BACKUP"; }
trap restore EXIT INT TERM

# name | invariant that must fail | perl expression applied to ShieldedPool.sol
#
# Each mutation is the smallest edit that removes one guarantee. The paired
# invariant is the one whose whole reason to exist is that guarantee, so the
# mapping doubles as documentation of what each invariant is for.
MUTANTS=(
  "double-credit|invariant_pooled_value_never_exceeds_the_balance_behind_it|s/pooledValue\[token\] \+= value;/pooledValue[token] += value * 2;/"
  "turnstile|invariant_outflow_never_exceeds_inflow_per_token|s/if \(outflow > pooledValue\[s\.token\]\) revert ExceedsPooledValue\(\);//; s/if \(outflow != 0\) pooledValue\[s\.token\] -= outflow;/if (outflow != 0) { unchecked { pooledValue[s.token] -= outflow; } }/"
  "nullifier-reuse|invariant_a_nullifier_is_never_accepted_twice|s/if \(nullifierSpent\[s\.nullifiers\[0\]\] \|\| nullifierSpent\[s\.nullifiers\[1\]\]\) revert AlreadySpent\(\);//"
  "commitment-reuse|invariant_a_commitment_is_never_accepted_twice|s/if \(committed\[s\.commitments\[0\]\] \|\| committed\[s\.commitments\[1\]\]\) revert DuplicateCommitment\(\);//"
  "leaf-stall|invariant_leaf_index_accounts_for_every_inserted_leaf|s/nextLeafIndex = insertIndex \+ 2;/nextLeafIndex = insertIndex + 1;/"
  "root-forgotten|invariant_recent_roots_stay_retrievable|s/knownRoot\[r\] = true;//"
)

WANTED="${1:-}"
pass=0; fail=0
printf '%-18s %-12s %s\n' "MUTANT" "RESULT" "INVARIANT"
printf '%s\n' "----------------------------------------------------------------------"

for entry in "${MUTANTS[@]}"; do
  IFS='|' read -r name inv expr <<<"$entry"
  [ -n "$WANTED" ] && [ "$WANTED" != "$name" ] && continue

  cp "$BACKUP" "$POOL"
  perl -0pi -e "$expr" "$POOL"

  if cmp -s "$BACKUP" "$POOL"; then
    printf '%-18s %-12s %s\n' "$name" "NO-OP" "$inv"
    echo "  the mutation matched nothing. The source moved under this script."
    fail=$((fail + 1))
    continue
  fi

  # A mutant is caught when the paired invariant FAILS. forge exits nonzero.
  if (cd "$CONTRACTS" && forge test --match-test "$inv" >/dev/null 2>&1); then
    printf '%-18s %-12s %s\n' "$name" "SURVIVED" "$inv"
    fail=$((fail + 1))
  else
    printf '%-18s %-12s %s\n' "$name" "caught" "$inv"
    pass=$((pass + 1))
  fi
done

restore
trap - EXIT INT TERM

echo
if [ "$fail" -eq 0 ]; then
  echo "$pass/$pass mutants caught. Source restored."
  exit 0
fi
echo "$fail mutant(s) survived out of $((pass + fail)). Source restored."
echo "A survivor means the invariant above does not actually constrain the code it names."
exit 1
