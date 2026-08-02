# Relayer daemon — the part that answers the internet

**Date** 2026-08-01 · **Audited commit** `90836c5` · **Tool** none exists; an adversarial harness against the
real daemon over a stub chain · **Scope** `src/relayer/server.ts`,
`src/relayer/client.ts`, and the sweep in `src/relayer/rebalance.ts`

**Outcome.** Six findings, all fixed. **One Medium, two Low, three
Informational.** Nothing reaches deposited value — the proof binds `recipient`,
`relayer` and `fee`, so a relayer cannot redirect a payout or inflate its own
fee past what was proved, and that held up under every case here. What it can
lose is its own float, and what it can stop being is available, which is the
same thing as the gasless path being down for everybody.

The two that matter: **anyone could set the fee for a whole token by creating a
dust pool that cost about a dollar**, and **one RPC hiccup at the wrong moment
killed the daemon outright**. The second needed no attacker at all.

## Why this phase exists

Everything else in [`../`](../README.md) reads code that runs when somebody we
can see calls it. The pool is immutable and checked from four directions. The
circuits are attacked constraint by constraint. The published package is
gated against what arrives from outside.

The relayer is none of those. It is a long-lived process holding a **funded
key**, listening on a public port, taking a payload written by an anonymous
caller, and signing transactions on the strength of it. It had **no test and no
report** — the only component in the protocol with neither. The monitoring
phase watches it from outside (is it up, is it on the right chain, has its
payout address moved), which is worth having and is not the same as reading it.

Gasless has been the default door on every spend surface in both clients since
2026-07-28. This process is a liveness dependency for most of the product.

## Status

🟢 clean · 🟡 watch, residual named · 🔴 act. Scale in [`../README.md`](../README.md).

| | Check | Result |
|---|---|---|
| 🟢 | A relayer cannot alter what it submits | held; `recipient`, `relayer` and `fee` are public inputs, so an altered spend fails to verify |
| 🟢 | The fee it demands cannot be set by an outsider | **was reachable, now refused** — R-01 |
| 🟢 | It survives its own endpoint failing | **was fatal, now survives** — R-02 |
| 🟢 | An anonymous request cannot buy unbounded upstream work | **was 6 RPC calls each, now capped** — R-03 |
| 🟢 | It never has two transactions in flight from one account | **was racy, now serialized** — R-04 |
| 🟢 | It does not hand its own infrastructure to a caller | **leaked the endpoint, now stripped** — R-05 |
| 🟢 | A wire field cannot be arbitrarily wide | **was unbounded, now 78 digits** — R-06 |
| 🟢 | An adapter upgrade does not cut off clients mid-migration | **was a hard cutover, now an allowlist** — R-07 |
| 🟢 | Every case can fail | 8 defences deleted one at a time, 8 caught |
| 🟡 | R-01's close is a bound, not a proof | with no honest pool answering there is nothing to disagree with. The residual is written out below |
| 🟡 | The fee floor can still be griefed into refusal | an attacker who can move a price can make a token unquotable, which costs the relayer nothing and drops that token to self-paid |

**No 🔴.** Nothing found here reaches deposited value.

```
npm run test:relayer            # the cases
npm run test:relayer-mutants    # proves each case constrains the defence it names
```

Both run offline against a stub chain, need no key, and are wired into CI.

## Deployed

**Both live relayers were moved onto these fixes on 2026-08-01.** `0.6.13`
installed from a local `npm pack` tarball (sha256 `d596bfca…0bfde5`, verified
identical on both ends), then `cowl-relayer` and `cowl-relayer-mainnet`
restarted. `NRestarts=0` and no error, throw or unhandled rejection in either
journal since.

Verified as running rather than merely installed: a `/relay` carrying a
100,000-digit `value` came back **400 `Bad value in relay payload.`**, which is
the R-06 bound. The pre-fix daemon accepts that field for parsing and refuses
later with 409, so the status code alone tells the two builds apart. Fee pricing
still works on every live token — COWL at its one tier, USDG across three,
testnet USDG across four — and `npm run test:relay` and `npm run watch` are both
green against the deployed daemons.

**Checked before deploying, not after:** the tier-spread guard was measured
against both live venues first, on the question of whether it refuses anything
that works today. It does not — COWL, AAPL and DIH each price at exactly one
tier, so there is nothing to disagree with, and USDG's three real tiers agree to
within 0.35%.

**On the registry as `0.6.14`, and that took two attempts.** `0.6.13` went up
from a build made before this audit, so for a while the box and the registry
both reported `0.6.13` and carried different code — the deceptive shape of "the
box is not running what we think it is", because no version check can see it.
Caught by grepping the published tarball for a string that only exists after the
fix, against controls (`Relayer is busy`, `zcowl`, `quoteExactOutputSingle`) that
hit in both bundles.

`0.6.14` was verified the same way and further: the published `dist/cli.mjs` and
the one the relayers are running are **919,980 bytes each and hash identically**
once the version literal is normalised. Registry, box and audited source are one
artifact.

The lesson is the one this tree keeps relearning: a version is a label somebody
types. What settled it was a string that only exists after the fix, beside
controls proving the search works.

## The method

`startRelayServer` is imported from source and stood up on loopback. Only the
chain underneath it is fake. The stub answers deterministically, can be told to
lie in one specific way per case, and — the part that matters — **counts every
RPC request the daemon makes**.

That count is the whole evidence for the amplification findings. A relayer under
a flood looks perfectly healthy from the outside, right up to the moment its
endpoint starts refusing it, and by then the useful measurement is gone. From
inside the stub it is a number.

The cases are written the way the surface is actually reached: no proof, no
wallet, no cost, one lie at a time.

**`control` comes first and is not a formality.** Every other case asserts that
something is refused, so all of them would pass against a relayer that refused
everything — including one that was simply broken. `control` requires an honest
quote to be answered and an honest spend paying that quote to be carried.

## R-07 — one adapter address is a hard cutover

**Found by shipping, not by reading.** A new trade adapter was deployed to
testnet carrying the L-01/L-02 fixes, the CLI was pointed at it, and the first
real trade came back:

```
✗ Trade spend does not pay the adapter.
```

Nothing was wrong with the new adapter. The **relayer** refused it, at
`server.ts:491`, because it compared the spend's recipient against exactly one
address — the adapter its own installed build knew about, which was still the
old one.

That check is right to exist. A relayer that submits a spend paying any address
a caller names is a machine for funding transfers to strangers out of somebody
else's shielded balance. What was wrong is that it admitted exactly one answer.

**Both directions fail closed, which is the part that makes it a real problem:**

| | |
|---|---|
| relayer old, client new | refused — this is what happened |
| relayer new, client old | refused — every user who has not upgraded |

Clients and relayers do not update in the same minute. npm publishes, users
upgrade when they feel like it, and a relayer is a systemd unit somebody has to
restart. With a single address there is no ordering that avoids an outage: ship
the relayer first and you break everyone who has not updated; ship the clients
first and the relayer refuses them all.

**Fixed** by matching against a set — the current adapter plus
`tradeAdapterLegacy`, every entry an address this project deployed and verified.
The set is read from `src/networks.ts` and never from the request, so it widens
what a relayer will pay by exactly the adapters we chose and by nothing else.
Accepting a previous adapter is no weaker than the day it was the current one.

Two cases pin it, and both are in CI:

| Case | Holds |
|---|---|
| `adapter-unknown` | a trade paying `0x…dEaD` is refused, and refused **for the adapter** rather than incidentally |
| `adapter-legacy` | a trade paying the previous adapter gets past the adapter check — it still fails later on its nonsense fee, which is the point |

And two mutants prove the cases bite: `adapter-any` deletes the check entirely,
`adapter-current-only` narrows the set back to one address. Both caught.

**Proven in production the same day.** Both relayers were upgraded to 0.6.15 and
restarted, and the trade that had been refused an hour earlier went through —
0.1 USDG received, 8,988,423 gas, submitted by `0xEAd4E3Ee…27A0` with the user's
wallet absent from the transaction entirely. Testnet was proven before the
mainnet relayer was touched, so a fault in the fix could not have taken gasless
down on the chain that holds money.

**The residual is housekeeping.** A legacy entry widens the set forever unless
somebody removes it. Prune an address once no client can still be building
against it — which in practice means once the npm version that carried it is old
enough that nobody runs it.

## Findings

| ID | Severity | Status | What |
|---|---|---|---|
| R-07 | **Low** | **Fixed** | A trade's unshield leg was checked against exactly one adapter address, so the day a new adapter shipped, every client still building against the old one was refused — and the reverse for anyone who upgraded early. Found by doing it: the 2026-08-02 rollout failed its first live trade |
| R-01 | **Medium** | **Fixed** | The fee floor was a spot AMM quote with no bound, and the cheapest of four tiers won. One dust pool at an unused tier set the fee for every spend in that token |
| R-02 | **Low** | **Fixed** | An endpoint failure in the window after a spend was answered took the whole daemon down, and every spend queued behind it |
| R-03 | **Low** | **Fixed** | An anonymous request bought up to six upstream RPC calls, uncapped and unauthenticated. The queue bounded transactions, not work |
| R-04 | Informational | **Fixed** | The fee sweep sent transactions from the same account as the next spend in line, and viem reads the nonce per transaction |
| R-05 | Informational | **Fixed** | Upstream error text was handed to the caller verbatim, carrying the endpoint URL and the outgoing request body |
| R-06 | Informational | **Fixed** | Wire fields carrying bigints as decimal strings had no width bound, against a 2MB body limit |

Severity is Impact × Likelihood, impact measured against deposited value first
and availability second. **No finding here touches deposited value**, which is
why none is above Medium — the ceiling for something that can only cost the
relayer its float and the product its gasless path.

---

### [R-01] Anyone could set the fee for a whole token · Medium · Fixed

**What it was.** The fee leg of an ERC-20 spend pays in that token, so the
daemon prices gas in the token by asking the venue quoter how much of it buys
`feeWei` of WETH. It asks **all four Uniswap V3 fee tiers and takes the
cheapest**, with a comment explaining why: the cheapest is the pool that would
really be routed through, and quoting a worse one would overcharge for gas that
costs the same either way.

That reasoning is about routing. Nothing routes here — the relayer receives the
token and sells it later, choosing its own tier at sell time. What the minimum
actually does is let the lowest number anyone can produce win.

**Anyone can produce a number.** Creating a Uniswap V3 pool at a tier that has
none is permissionless, and seeding it with a dust position at a price of your
choosing costs the WETH the quote has to be fillable for. A spend's fee on
mainnet today is **0.000114 ETH**, so the position is worth well under a dollar,
and it comes back out afterwards.

**Measured against the live venue, 2026-08-01.** How many of the four tiers
actually price each shielded token against WETH:

| Token | 0.01% | 0.05% | 0.3% | 1% | Honest tiers |
|---|---|---|---|---|---|
| COWL | — | — | — | 7,718 COWL | **1 of 4** |
| AAPL | — | 0.000705 AAPL | — | — | **1 of 4** |
| DIH | — | — | — | 12,241 DIH | **1 of 4** |
| USDG | 0.212794 | 0.212838 | 0.213546 | — | 3 of 4 |

Three of the four tiers are empty for COWL, AAPL and DIH. The attack needs one
pool creation against a token that only prices at one tier — which is three of
the four tokens in the pool.

**Proven end to end.** With one poisoned tier out of four and the other three
left honest, the quoted fee moved from `1000000000000000000` to `3`, and a spend
paying **3 base units** was accepted and submitted. The relayer burned a full
spend's gas for it. That is not a rounding error, it is the fee going to zero,
repeatable until the float is empty — 0.0402 ETH, about 358 spends.

**The fix, and its limit stated plainly.** The daemon now refuses to price a
token at all when the answering tiers disagree by more than a factor of four.

The constant is not a guess. Look at the USDG row above: three real pools on the
same pair, quoted in the same call, agreeing to within **0.35%**. Arbitrage
holds real tiers together; a factor of four is far outside anything an honest
market produces and far inside what a dust pool needs in order to be worth
creating. And it costs nothing today — a token that prices at one tier has
nothing to disagree with, so COWL, AAPL and DIH quote exactly as before.

**Refusing is a handled state**, not a new failure mode. Both clients already
fall back to self-paid for a token the relayer will not price, and say so.

**The residual, which is why this row is 🟡 rather than closed.** The guard works
by comparing an attacker's pool against an honest one. If the honest pool cannot
answer — no liquidity for that size at that moment — every answering tier
belongs to the attacker, they agree with each other, and the floor is theirs
again. Closing that needs an operator allowlist of which token prices through
which tier, which is a decision about what a relayer is willing to be paid in,
not a constant. **What the fix does guarantee is the direction of the failure:**
an attacker can now make a token unquotable, which costs the relayer nothing.
They can no longer make it work for free.

---

### [R-02] One endpoint hiccup killed the daemon · Low · Fixed

**What it was.** A relayed spend is answered from inside its queue job, and the
job keeps working after the response goes out: it records which token the fee
arrived in, then decides whether to sweep. The sweep decision opens with a
balance read that sat **outside** the function's own try block, so an endpoint
that blinked in that window rejected the promise.

It was fired as `void maybeSweep()`, so that rejection was an unhandled promise
rejection, which on Node 15 and up **terminates the process**.

There is no attacker in this finding. `robinhood-rpc.publicnode.com` returning
one 500 is enough, and this is a chain whose endpoints are documented in this
repository as flaky enough to need a fallback list.

**What it costs.** The units carry `Restart=on-failure` with `RestartSec=5s`, so
one crash is a five second outage plus every spend in the queue — up to eight
callers getting an error on a spend they had already proved. Neither unit sets
`StartLimitBurst`, so systemd's default applies: **five failures inside ten
seconds and it stops trying**. A sustained endpoint wobble does not blip the
relayer, it leaves the unit dead until a human runs `systemctl reset-failed`.

**Found by running the harness rather than by reading.** The first green run of
this suite crashed on teardown with `ERR_HTTP_HEADERS_SENT`, which is the same
bug wearing the shape the earlier fix gave it: with the sweep awaited inside the
job, the rejection reached the handler's catch, and the catch answered a request
that had already been answered.

**Fixed in two places, because it has two halves.**

1. The sweep's balance read moved inside the try, so `maybeSweep` cannot reject.
   "Failures are swallowed" was already the documented intent; one await was
   outside the part that swallows them.
2. `send()` returns early when the response has already been written. Any throw
   after a response — not just this one — would otherwise be an exception with
   nothing above it to catch.

The second is defence in depth and can only be reached when something else
throws first, which is why its mutant is a compound one. That is written down in
`mutants.mjs` rather than left as a mutant that passes for the wrong reason.

---

### [R-03] An anonymous request bought six RPC calls · Low · Fixed

**What it was.** `MAX_QUEUE = 8` was the only bound in the daemon, and it counts
**transactions**. Everything expensive about a request happens before it reaches
the queue, and a quote never enters the queue at all.

Measured, per anonymous request:

| Request | Upstream RPC calls |
|---|---|
| `GET /quote` | 2 |
| `GET /quote?token=0x…` | **6** — gas price, four tier quotes, balance |
| `POST /relay` with junk, rejected on fee | **5** — before any queue check |

Fifty concurrent quotes cost **301 upstream requests**, and every one of the
fifty was served. Fifty junk spends cost 250 and were all rejected with 409 —
the queue cap never engaged once, because it sits past the pricing.

The relayer polls a public endpoint. This repository already records that
thirdweb 429s under volume and that the only archive source rate-limits to about
one request per window. So the cost of taking the gasless path down for everyone
was a loop, from one machine, with no wallet and no proof.

**Fixed** with a cap on requests doing upstream work at once, and by moving the
queue check ahead of the pricing on `/relay` and `/trade` — a relayer with a full
queue is going to refuse the next spend whatever it says, so it should cost
nothing to say so. Fifty concurrent quotes now cost 96 upstream calls with 34
turned away, and a spend past a full queue is refused with **zero**.

Sixteen concurrent is far above what both clients generate together. It is a
cap, not a rate limit: sustained slow traffic is still unbounded over time, and
the thing that closes that is a reverse proxy, which is where it belongs.

---

### [R-04] The sweep raced the next spend for a nonce · Informational · Fixed

`maybeSweep` was fired detached, so it was still running when the next queued
spend began — and it sends its own transactions (approve, sell, unwrap) from the
same account. Neither path pins a nonce, and viem reads
`eth_getTransactionCount` per transaction, so two overlapping flows read the same
number and the chain keeps one of them.

The loser is a dropped transaction: either a relayed spend that fails for a
caller who did nothing wrong, or a sweep that silently does not happen. Neither
loses money and the caller can retry — but it happens exactly when the float is
low and the relayer is busy, which is the worst moment for either.

**Fixed** by awaiting the sweep inside the queue job, after the response has
already been written. The caller waits for nothing; the queue holds until the
sweep's transactions have landed. The case asserts the shape directly: no second
nonce read before the first one's send.

---

### [R-05] The endpoint came back to the caller · Informational · Fixed

viem writes the endpoint URL, the outgoing request body and its own version into
the message of any transport failure, and the daemon handed that message
straight to whoever asked:

```
{"error":"HTTP request failed.\n\nStatus: 500\nURL: http://…\nRequest body: [{\"method\":\"eth_gasPrice\"}]…"}
```

**Nothing secret leaks today** — every endpoint in `src/networks.ts` is a keyless
public URL. It is recorded because `deploy/relayer` tells operators to pin their
own endpoint rather than rely on the fallback list, and an operator who does that
with a keyed provider publishes the key on the first RPC hiccup.

**Fixed** by stripping the `URL`, `Request body` and `Version` lines from what a
caller is told. The chain's own reason survives, which it has to: a spender needs
to tell a stale root from a spent nullifier. The operator's log keeps the whole
message.

---

### [R-06] A wire field could be two million digits wide · Informational · Fixed

`decodeSpend` validated that a bigint field was decimal but not how long it was,
against a 2MB body limit. A million-digit `value` cost **123ms of the daemon's
single thread** per request, and nothing on this wire is wider than a uint256.

**Fixed** with a 78-digit bound, which is exactly `2^256 - 1`. Refusal now takes
5ms.

---

## What the plan suspected, checked and closed

[`../../../AUDIT-PLAN.md`](../../../AUDIT-PLAN.md) names one concrete suspected
defect in this component:

> `GAS_PER_TRADE` is currently `15_000_000` against roughly 8.6M observed, which
> would be a silent 74% markup the moment trades route through it.

**Not true any more, and worth recording as checked rather than assumed.** The
constant became per network. Mainnet carries `tradeGas: 9_000_000n` against the
8,599,108 the first real-money trade burned — about 4.7% of headroom over the
worst observed, which is the same shape as `GAS_PER_SPEND` at 4,450,000 against
a worst observed 4,430,686. The 15M figure survives only as the fallback for a
network that has never been measured, where over-quoting is the safe direction.

## Proving the cases can fail

A suite that has only ever been green has demonstrated nothing. `mutants.mjs`
deletes one defence at a time and requires the case that names it to go red.

| Mutant | The defence it removes | Caught by |
|---|---|---|
| `tier-spread` | the refusal when the venue's tiers disagree | `tier-spread` |
| `inflight` | the cap on requests doing upstream work at once | `quote-flood` |
| `queue-order` | checking the queue before pricing the fee | `full-queue` |
| `rpc-leak` | stripping the endpoint out of what a caller is told | `rpc-leak` |
| `sweep-catch` | the sweep's balance read from inside the try | `survive-blip` |
| `double-send` | the guard against answering one request twice | `survive-blip` |
| `sweep-detached` | holding the queue while the sweep sends | `sweep-nonce` |
| `wide-field` | the width bound on a decimal field | `wide-field` |

**8/8 caught.** Three guards are worth explaining, because each was added after
a mutant lied about something:

**Every pattern must match exactly one site.** A pattern that matches nothing is
an error, not a silent skip — a skipped mutation leaves the code intact, the
case passes, and it scores as a surviving mutant that was never applied.

**`double-send` is compound, and has to be.** The `headersSent` guard only does
anything when something throws after the response has gone out, and the sweep's
balance read is the only thing that can. Removing the guard alone leaves nothing
to guard against, so the case passes — which is exactly what happened on the
first run, and it was recorded as a survivor rather than argued away. The mutant
now removes both, which is the shape the daemon had before this audit.

**`queue-order` moves the check rather than deleting it.** Deleting the cap
leaves the ninth spend waiting in a queue that never drains, so the case times
out — and a hang is scored as "the suite could not run", which is not a verdict
either way. The mutant restores the check to where it sat before this audit,
after the pricing it was meant to be protecting, and the case reports the real
number: refusing one spend still cost five upstream calls.

The source is edited in place, restored in a `finally` and on SIGINT, SIGTERM
and SIGHUP, and checked byte for byte at the end. A killed harness that leaves a
defence deleted in the working tree is worse than one that never ran.

**One mutation harness at a time.** This one edits first-party source in place,
and so do three others in this tree. Since 2026-08-01 they share a lock — two at
once would mean the second one's "original" was the first one's mutant, and its
restore would write a weakened file back as the baseline. It refuses rather than
queues, and takes over a lock older than an hour so a crashed run cannot block
the tree. [`../lib/mutation-lock.mjs`](../lib/mutation-lock.mjs).

## What this phase does not cover

- **Rate limiting over time.** The in-flight cap bounds concurrency, not
  requests per hour. A slow steady flood is still unbounded, and the answer to
  that is a reverse proxy in front of the daemon rather than a counter inside
  it. Both relayers already sit behind Caddy; nothing there limits anything yet.
- **The sweep's own slippage.** `sweepToGas` derives `minOut` from the same
  quoter this report has just shown to be manipulable, so a sweep can be
  sandwiched. It sells the relayer's own fees rather than anybody's deposit, and
  it was left alone deliberately: one step at a time, and this one is about the
  door that faces outward.
- **The float still only refills from outside.** A relayer that runs dry stays
  dry until a human sends it ether. That is [`../monitoring/`](../monitoring/README.md)'s
  finding, not this one, and it is still open.
- **Nothing here proves the daemon on the VPS is this code.** The monitoring
  phase asks it what it is and cross-checks the answer against the chain, which
  is the closest available thing and is not the same thing.

## Files

| Path | What it is |
|---|---|
| `src/relayer/server.ts` | the daemon; R-01 through R-05 are fixed here |
| `src/relayer/client.ts` | the wire format; R-06 is fixed here |
| `audits/relayer/harness.mjs` | the stub chain and the daemon's lifecycle |
| `audits/relayer/attack.mjs` | the cases |
| `audits/relayer/mutants.mjs` | proves each case constrains the defence it names |
