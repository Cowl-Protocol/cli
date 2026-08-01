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

**Everything below is CLI.** Safe's web app needs a browser wallet, which would
mean importing one of these keystores into a browser extension — moving the key
that guards the pool's escape hatch into a far softer target than an encrypted
file that is only opened to sign. The keys never leave their keystores here.

The web app can still be used read-only to *view* the Safe once it exists.

Safe 1.4.1 is deployed on both chains — singleton, proxy factory and fallback
handler all verified present on 46630 and 4663.

### Set these once per shell

```bash
export RPC=https://46630.rpc.thirdweb.com
export POOL=0xf9F825f2D6d8509c78baaa587694f74672C32A59
export FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
export SINGLETON=0x41675C099F32341bf84BFc5382aF534df5C7461a
export HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99
export ZERO=0x0000000000000000000000000000000000000000
export K1=~/Vaults/Cowl/sig1/cowl-sig-1
export K2=~/Vaults/Cowl/sig2/cowl-sig-2
export K3=~/Vaults/Cowl/sig3/cowl-sig-3
```

### A1 — build the Safe's setup call

```bash
export INIT=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
  "[0x87512e7b03d649372efF6c6db2f575ea6cEC4e91,0x1aa8e8bD2289fdbc745b22CE8320607fBb7168ae,0x1A4464d7A5EfF3b9FCb3cAe9B26227fddF22Ad77]" \
  2 $ZERO 0x $HANDLER $ZERO 0 $ZERO)
```

The `2` is the threshold. Everything after `$HANDLER` is the payment-refund
mechanism Safe's setup offers and which is not being used: no token, no amount,
no receiver.

### A2 — find out the address before creating it

`createProxyWithNonce` is CREATE2, so a simulated call returns exactly the
address a real one would deploy. Look before you leap:

```bash
cast call $FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" \
  $SINGLETON $INIT 0 --rpc-url $RPC
```

```bash
export SAFE=<the address that printed>
```

### A3 — create it

```bash
cast send $FACTORY "createProxyWithNonce(address,bytes,uint256)" \
  $SINGLETON $INIT 0 --keystore $K1 --rpc-url $RPC
```

### A4 — verify it from the chain, not from a UI

```bash
cast call $SAFE "getOwners()(address[])"   --rpc-url $RPC
cast call $SAFE "getThreshold()(uint256)"  --rpc-url $RPC
cast call $SAFE "VERSION()(string)"        --rpc-url $RPC
```

Three addresses matching the table above, `2`, and `1.4.1`. Anything else stops
here.

### A5 — hand the testnet pool over

```bash
cast send $POOL "transferOwnership(address)" $SAFE \
  --account cowl-deployer --rpc-url $RPC

cast call $POOL "owner()(address)" --rpc-url $RPC     # must equal $SAFE
```

### A6 — the rehearsal itself: propose a swap from the Safe

This is the part that proves the Safe can *operate* the hatch. Four steps,
because a Safe transaction is signed off-chain by owners and submitted by one of
them.

**Build the inner call and the Safe's own transaction hash:**

```bash
export DATA=$(cast calldata "proposeVerifierSwap(uint8,address)" 0 0x000000000000000000000000000000000000dEaD)
export NONCE=$(cast call $SAFE "nonce()(uint256)" --rpc-url $RPC)

export TXHASH=$(cast call $SAFE \
  "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  $POOL 0 $DATA 0 0 0 0 $ZERO $ZERO $NONCE --rpc-url $RPC)
```

**Sign that hash with two owners.** `--no-hash` is essential: Safe expects a
signature over the transaction hash itself, not over an
`\x19Ethereum Signed Message` wrapping of it.

```bash
export S2=$(cast wallet sign --no-hash $TXHASH --keystore $K2)
export S1=$(cast wallet sign --no-hash $TXHASH --keystore $K1)
```

**Concatenate them in ascending owner-address order.** Safe rejects
out-of-order signatures, and the order is by address, not by who signed first:

| order | owner | address |
|---|---|---|
| 1st | sig3 | `0x1A4464d7…Ad77` |
| 2nd | sig2 | `0x1aa8e8bD…68ae` |
| 3rd | sig1 | `0x87512e7b…4e91` |

With sig2 and sig1, that means **sig2 first**:

```bash
export SIGS=0x${S2#0x}${S1#0x}
```

**Submit it.** Any owner can, and only this one pays gas:

```bash
cast send $SAFE \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  $POOL 0 $DATA 0 0 0 0 $ZERO $ZERO $SIGS \
  --keystore $K1 --rpc-url $RPC
```

**Confirm the pool saw it:**

```bash
cast call $POOL "pendingSwap(uint8)(address,uint64)" 0 --rpc-url $RPC
```

A non-zero verifier and an `executeAfter` roughly seven days out.

### A7 — cancel it, which is the other half of the proof

Same four steps with a different inner call. **Re-read the nonce** — it advanced
when A6 executed, and a stale nonce produces a hash nobody will accept:

```bash
export DATA=$(cast calldata "cancelVerifierSwap(uint8)" 0)
export NONCE=$(cast call $SAFE "nonce()(uint256)" --rpc-url $RPC)
export TXHASH=$(cast call $SAFE \
  "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  $POOL 0 $DATA 0 0 0 0 $ZERO $ZERO $NONCE --rpc-url $RPC)

export S2=$(cast wallet sign --no-hash $TXHASH --keystore $K2)
export S1=$(cast wallet sign --no-hash $TXHASH --keystore $K1)
export SIGS=0x${S2#0x}${S1#0x}

cast send $SAFE \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  $POOL 0 $DATA 0 0 0 0 $ZERO $ZERO $SIGS \
  --keystore $K1 --rpc-url $RPC

cast call $POOL "pendingSwap(uint8)(address,uint64)" 0 --rpc-url $RPC
```

Back to the zero address and `0`. **That round trip is the rehearsal.** It shows
two of three signatures move the hatch, that the Safe reaches the pool, and that
a mistaken proposal can be withdrawn — all on a pool holding nothing.

### A8 — leave testnet owned by the Safe

It stays the rehearsal ground, so no governance action is ever attempted on
mainnet first.

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
