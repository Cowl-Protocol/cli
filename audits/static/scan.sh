#!/usr/bin/env bash
#
# Static analysis of the hand-written contracts. Regenerates both reports in
# this directory. Run from anywhere:
#
#     cli/audits/static/scan.sh
#
# Requires slither and aderyn on PATH. Both were installed at the time of
# writing (slither 0.11.5, aderyn 0.6.8, forge 1.7.1).
#
# ---------------------------------------------------------------------------
# Why slither needs a shim
#
# `slither .` on the real project crashes in its own parser, before any
# detector runs:
#
#     slither/visitors/expression/constants_folding.py, _post_identifier
#     assert isinstance(expr, Literal)  ->  AssertionError
#
# The trigger is the bb-generated Honk verifier, which declares struct members
# whose array length is a constant *identifier* rather than a literal:
#
#     Fr[NUMBER_OF_ALPHAS] alphas;              (TransferVerifier.sol:497)
#     Fr[CONST_PROOF_SIZE_LOG_N] gateChallenges;
#
# Slither folds array lengths and asserts the expression is a literal. This is
# a slither limitation, not a finding about our code.
#
# The verifiers are machine output from barretenberg and are not a slither
# target anyway: they are assembly-heavy generated code where slither produces
# only noise, and the bug class that matters there (an unsound verifier) is not
# something a Solidity linter can see. So the scan runs against a copy of the
# tree where the two generated verifiers are replaced by the single interface
# the hand-written contracts actually consume. Nothing in
# ShieldedPool.sol / CowlTradeAdapter.sol / TestVenue.sol is modified.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/../../contracts" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Production contracts only. The venue mocks moved to test/mocks/ on 2026-07-28
# precisely so they stop showing up here — they were 40% of the first scan.
TARGETS="src/ShieldedPool.sol,src/CowlTradeAdapter.sol"

# --- aderyn: reads the real tree, just needs the scope narrowed -------------
echo "==> aderyn"
aderyn "$CONTRACTS" -i "$TARGETS" -o "$HERE/aderyn-report.md"

# --- slither: needs the shimmed copy ---------------------------------------
echo "==> slither"
mkdir -p "$WORK/src"
cp "$CONTRACTS"/src/ShieldedPool.sol \
   "$CONTRACTS"/src/CowlTradeAdapter.sol "$WORK/src/"

# The shim must stay identical to the interface the real verifier exports, or
# the scan would be analysing a different contract than the one we deploy.
EXPECTED='function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool);'
if ! grep -qF "$EXPECTED" "$CONTRACTS/src/ShieldVerifier.sol"; then
    echo "IVerifier in ShieldVerifier.sol no longer matches the shim below." >&2
    echo "Update scan.sh before trusting this report." >&2
    exit 1
fi

cat > "$WORK/src/ShieldVerifier.sol" <<'SHIM'
// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.21;

// Analysis shim, see scan.sh. The real file is the bb-generated Honk verifier;
// only this interface is consumed by the hand-written contracts.
interface IVerifier {
    function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool);
}
SHIM

cat > "$WORK/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
TOML

ln -s "$CONTRACTS/lib" "$WORK/lib"

# slither refuses to overwrite an existing --json target and only says so on
# stderr, so a re-run would otherwise leave the previous scan in place while
# looking like it succeeded.
rm -f "$HERE/slither-raw.json"

# slither exits non-zero whenever it finds anything, which is always.
( cd "$WORK" && slither . --json "$HERE/slither-raw.json" 2>"$HERE/slither-report.txt" ) || true

if [ ! -s "$HERE/slither-raw.json" ]; then
    echo "slither produced no JSON — see $HERE/slither-report.txt" >&2
    exit 1
fi

echo
echo "Wrote:"
echo "  $HERE/aderyn-report.md"
echo "  $HERE/slither-raw.json"
echo "  $HERE/slither-report.txt"
echo
echo "Triage and verdicts live in $HERE/README.md — a finding is not a defect"
echo "until it is written up there."
