# Moving pool ownership to a multisig

Closes the open half of **M-01** — the pool's escape hatch is held by a single
deployer EOA. See [`../../audits/static/README.md`](../../audits/static/README.md)
for the finding and [`../../audits/monitoring/README.md`](../../audits/monitoring/README.md)
for what to do when it fires.

**Every transaction here is signed by the owner of the keys. Nothing in this
file is executed for you.** The verification steps are the parts to run before
and after each transaction, and they are the reason this is a document rather
than a script.

## What is actually being changed

The pool is immutable. Its bytecode cannot change, it has no pause, and no owner
function moves value. What ownership controls is exactly five calls:

`proposeVerifierSwap` · `executeVerifierSwap` · `cancelVerifierSwap` ·
`transferOwnership` · `renounceOwnership`

The first two, seven days apart, can install a verifier that accepts any proof —
after which `ExceedsPooledValue` caps a drain at all of `pooledValue`. That is
the whole exposure, and moving it behind a threshold is the whole point of this
migration.

**No product path touches ownership.** `owner()` is called nowhere in `cli/src`
or `app/lib`. Shield, send, trade, unshield and the relayer all behave
identically before and after. Users see nothing.

## The owners

Three fresh EOAs, generated 2026-08-01, each proven able to sign before being
named here. The deployer is deliberately **not** among them — it has lived
beside the source on a development machine for too long to be one of three.

| | Address | Verified |
|---|---|---|
| sig1 | `0x87512e7b03d649372efF6c6db2f575ea6cEC4e91` | signs · fresh · not a contract |
| sig2 | `0x1aa8e8bD2289fdbc745b22CE8320607fBb7168ae` | signs · fresh · not a contract |
| sig3 | `0x1A4464d7A5EfF3b9FCb3cAe9B26227fddF22Ad77` | signs · fresh · not a contract |

Each was confirmed by recovering the address from a real signature rather than
by reading it off the keystore, so the file, the address and the ability to sign
are known to be the same thing.

### Threshold: 2 of 3

**Written as 2-of-3.** If you want 3-of-3, say so before Phase A — but read this
first.

3-of-3 looks stricter and is a trap. Losing **any one** key makes the escape
hatch unreachable forever, which is the same end state as `renounceOwnership`,
arrived at by accident instead of by decision. We have already decided renouncing
is premature while the circuits have had no external review.

2-of-3 survives one lost key and still requires two independent compromises.
It is better in both directions at once.

### The residual, stated plainly

All three keystores currently live on one laptop, in separate directories, under
separate passphrases. That defeats a copied folder, a leaked backup, a synced
directory, a single exposed file. It does **not** defeat a fully compromised
machine with persistence, which will eventually observe passphrases as they are
typed.

The defence against that case remains what it already was: the 7-day delay, and
a watcher that is actually running. This migration does not replace
[`../watch/`](../watch/README.md) — it makes it matter more.

**The availability risk is the larger one here.** One laptop failing loses all
three keys at once, and 2-of-3 with two keys gone is 0-of-3: the hatch is dead
permanently. At least two of the three keystores must have a backup on separate
media, with their passphrases stored apart from both.

## Before anything: gas

Safe signatures are collected off-chain; only the signer who **executes** pays
gas. Fund `sig1` first — testnet ETH on 46630 for Phase A, then a small amount of
real ETH on 4663 for Phase B.

Eventually fund all three a little, so any two can act without waiting on a
top-up during an incident.

## Phase A — testnet, in full, before mainnet is touched

The testnet pool `0xf9F825f2D6d8509c78baaa587694f74672C32A59` has the same owner
and holds nothing. The rehearsal is not optional and it is not a formality:
what it proves is that the destination can **operate** the hatch, not merely
receive it. An address that can be made owner but cannot sign takes the escape
hatch with it, permanently, with no way back.

Safe's hosted app supports both chains — verified against
`safe-config.safe.global`: chain 4663 is listed as *Robinhood Chain* and 46630 as
*Robinhood Testnet*.

**A1.** Create the Safe on **46630** with the three owners above and threshold 2.

**A2.** Verify it before trusting it. Ask for the numbers to be read back from
the chain, not from the UI:

```
cast call <SAFE> "getOwners()(address[])"  --rpc-url <testnet rpc>
cast call <SAFE> "getThreshold()(uint256)" --rpc-url <testnet rpc>
```

Three addresses, matching the table above, and `2`. Anything else stops here.

**A3.** Transfer the testnet pool to it, from the deployer:

```
cast send 0xf9F825f2D6d8509c78baaa587694f74672C32A59 \
  "transferOwnership(address)" <SAFE> \
  --account cowl-deployer --rpc-url <testnet rpc>
```

**A4.** Confirm the pool now answers with the Safe:

```
cast call 0xf9F825f2D6d8509c78baaa587694f74672C32A59 "owner()(address)" --rpc-url <testnet rpc>
```

**A5. The step the rehearsal exists for.** From the Safe, with two signatures,
propose a verifier swap and then cancel it:

```
proposeVerifierSwap(0, <any non-zero address>)
cancelVerifierSwap(0)
```

Watch `pendingSwap(0)` go non-zero and back to zero. **This is the proof.** It
demonstrates the Safe can reach the hatch, that two of three signatures are
enough, and that a mistaken proposal can be withdrawn — all on a pool holding
nothing.

**A6.** Leave testnet owned by the Safe. It stays the rehearsal ground for every
future governance action, so nothing is ever attempted first on mainnet.

## Phase B — mainnet

Only after every step of Phase A has passed.

**B1.** Create the Safe on **4663**, same three owners, same threshold. It will
almost certainly have a different address from the testnet one; do not assume,
read it.

**B2.** Verify owners and threshold from the chain, exactly as in A2.

**B3.** Transfer the mainnet pool:

```
cast send 0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E \
  "transferOwnership(address)" <SAFE> \
  --account cowl-deployer --rpc-url https://robinhood-rpc.publicnode.com
```

**B4.** Confirm:

```
cast call 0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E "owner()(address)" \
  --rpc-url https://robinhood-rpc.publicnode.com
```

`transferOwnership` is instant, single-step, and has no acceptance handshake.
There is no undo. B2 is what stands between this and a permanent loss.

## Phase C — the part that is easiest to forget

**C1.** Re-record the watcher's baseline, or it alarms `owner CHANGED` on every
run from here to forever, and an alarm that always fires is an alarm that stops
being read:

```
npm run watch -- --update
```

**C2.** Commit `audits/monitoring/pool-baseline.json`. Drift is only detectable
against a recorded expectation.

**C3.** Update the reports that describe ownership as a single EOA:

- `audits/static/README.md` — M-01, both the status row and the finding
- `audits/monitoring/README.md` — the baseline table and the `owner CHANGED` playbook
- `audits/bounty/README.md` — K-1
- `audits/README.md` — the Governance row on the status board

## What not to do

**Do not renounce.** After `renounceOwnership()` the verifiers can never change,
which is the right long-run state and the wrong state today: it is the only fix
path available if the circuits turn out to have a soundness bug, and **no
external reviewer has read them yet**. Renouncing before that review trades a
detectable, delayed, key-dependent risk for an undetectable, instant, unfixable
one.

When it is eventually right, let the **Safe** make that call, so a once-and-
forever decision needs more than one signature.

**Do not transfer to an address you have not seen sign.** All three owners here
were verified by recovering an address from a real signature. Hold the Safe to
the same standard: A5 is that proof.

**Do not skip Phase A.** It is free, it holds nothing, and it is the only place
a mistake costs nothing.
