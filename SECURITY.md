# Security policy

Cowl runs a shielded pool on Robinhood Chain mainnet that holds real money. The
pool is **immutable**: it is not a proxy, it cannot be edited, and it has no
pause. That shapes everything below. If something is wrong with the deployed
contract, the response is never a patch.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository: the **Security** tab, then **Report a vulnerability**. It is
private between you and the maintainers from the first message.

If that is unavailable, reach us on X at
[@cowlprotocoll](https://x.com/cowlprotocoll) and ask for a private channel. Send
the details only once one exists.

Useful in a first report: what you can make the code do, the smallest input that
does it, which contract or package and at which commit, and whether you have run
it against a live deployment or only locally.

## What we commit to

- An acknowledgement that a human has read it, within **72 hours**.
- An assessment of impact and a plan, within **7 days**.
- Credit in the fix, if you want it, and none if you do not.
- No legal action against good-faith research that follows this policy.

We do not currently run a paid bounty. If that changes it will be announced
rather than negotiated per report.

## In scope

- `contracts/src/ShieldedPool.sol` and `contracts/src/CowlTradeAdapter.sol`
- The Noir circuits under `circuits/` and the verifiers generated from them
- The published npm package `@cowlprotocol/cli`
- The gasless relayer at `relay.cowlprotocol.com`
- Anything that lets a spend verify when it should not, lets value leave the
  pool that did not enter it, or reveals which deposit funded which withdrawal

## Out of scope

- The chain itself, its RPC endpoints, and the block explorer
- Third-party venues the trade adapter routes through
- Reports that a token nobody deposited through `shield()` sits in the contract
  with `pooledValue` zero. That is expected and those balances are
  unwithdrawable by anyone, deliberately
- Findings from an automated scanner with no reachability argument. Every
  finding in [`audits/`](audits/) carries one, and so should a report

## Good-faith testing

Test against **Robinhood Chain testnet (46630)**, not mainnet. Both pools run the
same code, the testnet one holds no real value, and the CLI targets it by
default. If a proof of concept genuinely requires mainnet, keep the amounts
trivial and tell us before, not after.

Do not test the relayer by exhausting its gas float. It is a shared piece of
infrastructure and draining it removes the gasless path for everyone. If you
believe you can drain it, describe how instead.

## What we already know about

Read [`audits/README.md`](audits/README.md) before reporting. It is the live
tracker for every audit artifact in this repository, with a status board and a
report per piece of work, and it records accepted findings with the reasoning
that accepted them. A report that lands on something already written up there is
still welcome — a second opinion on a rebuttal is worth having — but say that is
what it is.
