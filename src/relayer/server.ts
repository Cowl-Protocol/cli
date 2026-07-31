// The relayer daemon behind `cowl relay serve`.
//
// Anyone running the CLI can be a relayer: unlock a wallet, listen, submit
// other people's proven spends from it, and earn the fee leg of each one. The
// proof binds recipient, relayer and fee, so there is nothing to steal and
// nothing to trust — a submitted spend pays out exactly as proven or reverts.
// Living inside the CLI is deliberate: every install is a potential relayer,
// and the relayer set is meant to grow the same way the pool does.
//
// v1 relays native-coin spends. An ERC-20 fee leg pays in that token, which
// needs a price to convert gas into — a later problem, not a this-week one.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Address, PrivateKeyAccount } from "viem";
import type { NetworkDef } from "../networks.js";
import { publicClient } from "../chain.js";
import { poolAddress, simulateSpend, submitSpend, simulateTrade, submitTrade } from "../shielded/contract.js";
import { decodeSpend, decodeTrade } from "./client.js";
import { sweepToGas } from "./rebalance.js";

/** The V3 quoter surface used to price a fee in a non-native token. */
const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/**
 * A spend's gas, measured rather than rounded up.
 *
 * Every spend the mainnet pool has settled burned between 4,348,677 and
 * 4,430,686 — a spread under two percent, because the circuit does the same work
 * every time. Quoting five million on top of that was a second markup nobody
 * could see: the margin below says 25%, but the bill came to 43%. This sits just
 * above the highest ever observed, and the margin covers the rest.
 */
const GAS_PER_SPEND = 4_450_000n;

/**
 * An atomic trade's gas, which depends on the venue rather than the circuit, so
 * each network carries its own figure. A network that has never been measured
 * falls back to the slowest one known rather than under-quoting its own relayer
 * into paying the difference.
 */
function gasPerTrade(net: NetworkDef): bigint {
  return net.tradeGas ?? 15_000_000n;
}

/** Below this many spends' worth of gas, every quote says so on the console. */
const LOW_FLOAT_SPENDS = 20n;

/**
 * When the float has fallen this far below where it started, sell the fees.
 *
 * A relayer is paid in whatever token each spend moved and pays gas in the
 * native coin, so without this the two never meet: tokens accumulate while the
 * float drains away. Half is late enough that a sweep is worth its own gas and
 * early enough that there is still gas left to pay for one.
 */
const SWEEP_AT_FRACTION = 2n; // half of the float first seen

/** Spends waiting in line before new ones get a 429. Spends serialize on the
 * pool root, so a long queue only grows stale — better to say busy early. */
const MAX_QUEUE = 8;

/**
 * Requests being priced at once, before any of them reaches the queue.
 *
 * `MAX_QUEUE` bounds the transactions this relayer will have in flight; it
 * bounds nothing upstream. Pricing a quote costs a gas price, up to four quoter
 * calls and a balance read — six RPC requests that an anonymous caller triggers
 * for free, and that the queue never sees because a quote never enters it. On a
 * chain whose endpoints rate-limit, that is how one machine takes the gasless
 * path down for everyone without spending anything.
 *
 * Sixteen is far above what the app and CLI generate together and far below
 * what an endpoint will tolerate, so honest traffic never meets it.
 */
const MAX_INFLIGHT = 16;

/**
 * How far the venue's own fee tiers may disagree about a token before this
 * relayer stops believing any of them.
 *
 * A pair's tiers are held together by arbitrage: a real spread of more than a
 * few percent does not survive a block, let alone a factor of four. Anyone can
 * create a pool at a tier that has none and seed it with a dust position at a
 * price of their choosing, and `feeInToken` takes the cheapest quote it is
 * offered — so without this, one dust pool costing about a dollar sets the fee
 * for every spend in that token, and the relayer carries the gas.
 *
 * Refusing is the safe direction and a handled one: both clients already fall
 * back to self-paid for a token the relayer will not price, and say so. The
 * residual is named in `audits/relayer/README.md` — with no honest pool
 * answering there is nothing to disagree with, and the close for that is an
 * operator allowlist rather than a constant.
 */
const MAX_TIER_SPREAD = 4n;

/** A rejection the spender fixes by re-quoting and reproving (409), as opposed
 * to a malformed payload (400). */
class Reprove extends Error {}

export type RelayServerOpts = {
  port: number;
  /** Percent on top of raw gas cost — the relayer's take. */
  marginPct: number;
};

export type RelayEvent =
  | { kind: "quote"; feeWei: bigint }
  | { kind: "relayed"; hash: `0x${string}`; feeWei: bigint; gasUsed: bigint }
  | { kind: "rejected"; reason: string };

async function feeNow(net: NetworkDef, marginPct: number, gasUnits: bigint = GAS_PER_SPEND): Promise<bigint> {
  const gasPrice = await publicClient(net).getGasPrice();
  return (gasPrice * gasUnits * BigInt(100 + marginPct)) / 100n;
}

/**
 * The venue's fee tiers, cheapest first.
 *
 * A pair does not live at one tier: the deepest WETH/USDG pool sits at 0.05%
 * while a thinner token's only pool can be at 1%. Asking a single configured
 * tier meant a token whose pool was anywhere else read as "no price at all",
 * and the relayer refused a spend it could perfectly well have carried.
 */
const FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Price `feeWei` worth of gas in `token`, by asking the venue quoter how much
 * of the token buys exactly that much WETH. The fee leg of an ERC-20 spend
 * pays in that token, so this is what makes relaying one worth the gas.
 *
 * The configured tier is tried first and the rest follow, cheapest onward, and
 * the cheapest quote wins so a spender is not charged for a thin pool nobody
 * would trade through.
 *
 * That used to be the whole rule, and taking the lowest number anyone can
 * produce is a rule about who gets to produce it. Creating a pool at an empty
 * tier is permissionless, so the cheapest quote could be a dust position priced
 * by whoever wanted a free ride. `MAX_TIER_SPREAD` is what stands between those
 * two readings: the tiers still compete, but only while they agree that they
 * are pricing the same thing.
 */
async function feeInToken(net: NetworkDef, token: Address, feeWei: bigint): Promise<bigint> {
  const quoter = net.contracts.quoter;
  const weth = net.contracts.weth;
  if (!quoter || !weth) throw new Error("This relayer has no price source for that token — withdraw the native coin, or drop --relay.");

  const configured = net.contracts.feeTier;
  const tiers = configured ? [configured, ...FEE_TIERS.filter((t) => t !== configured)] : [...FEE_TIERS];

  const client = publicClient(net);
  const quotes = await Promise.all(
    tiers.map(async (fee) => {
      try {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: QUOTER_ABI,
          functionName: "quoteExactOutputSingle",
          args: [{ tokenIn: token, tokenOut: weth, amount: feeWei, fee, sqrtPriceLimitX96: 0n }],
        });
        return result[0] > 0n ? result[0] : null;
      } catch {
        // No pool at this tier, which is the common case and not an error.
        return null;
      }
    }),
  );

  const priced = quotes.filter((q): q is bigint => q !== null);
  if (priced.length === 0) {
    throw new Error(
      "No pool on this venue prices that token against WETH, so its fee cannot be charged — withdraw the native coin, or submit it yourself.",
    );
  }

  const cheapest = priced.reduce((best, q) => (q < best ? q : best));
  const dearest = priced.reduce((worst, q) => (q > worst ? q : worst));
  // Two tiers that disagree by more than MAX_TIER_SPREAD are not two prices for
  // the same thing, and taking the lower of them is how the cheap one wins.
  if (cheapest * MAX_TIER_SPREAD < dearest) {
    throw new Error(
      "This venue's fee tiers disagree about that token by too much to price a fee against — withdraw the native coin, or submit it yourself.",
    );
  }
  return cheapest;
}

/**
 * What an anonymous caller is told when something below fails.
 *
 * A rejection has to carry the chain's own reason or the spender cannot tell a
 * stale root from a spent nullifier. What it must not carry is the operator's
 * infrastructure: viem writes the endpoint URL and the outgoing request body
 * into the message of any transport failure, and this relayer answers the open
 * internet. Today's networks resolve to keyless public endpoints, so nothing
 * secret leaks; a relayer pointed at its own keyed endpoint — which
 * `deploy/relayer` tells operators to do — would publish the key on the first
 * RPC hiccup.
 */
function publicError(message: string): string {
  return (
    message
      .split("\n")
      .filter((line) => !/^\s*(URL|Request body|Version)\s*:/i.test(line))
      .join("\n")
      .trim() || "The relayer could not carry that."
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // A relayed spend answers from inside its queue job and then keeps working —
  // remembering the fee token, sweeping. Anything that throws after that point
  // reaches the handler's catch, which would answer a request that has already
  // been answered, and writing headers twice is a thrown exception with no
  // catch above it. One request would take the whole daemon down, and every
  // spend queued behind it with it.
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Payload too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the relayer. `onEvent` feeds the CLI's log lines; the server itself
 * stays quiet. Returns the close handle.
 */
export function startRelayServer(
  net: NetworkDef,
  account: PrivateKeyAccount,
  opts: RelayServerOpts,
  onEvent: (e: RelayEvent) => void,
): Promise<{ close: () => void }> {
  const pool = poolAddress(net);
  if (!pool) throw new Error(`No shielded pool deployed on ${net.label}.`);

  // Spends serialize on the pool root, so relay them one at a time — a queue,
  // not a race the loser of which burns the relayer's gas on a revert.
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;

  // Every ERC-20 a fee has ever arrived in. Kept in memory on purpose: a
  // restart forgets nothing that matters, since the sweep re-reads balances
  // from the chain and a token with none is skipped in a single call.
  const feeTokens = new Set<Address>();
  // The float as it stood when this relayer started, and the mark it sweeps at.
  let floatHighWater = 0n;
  let sweeping = false;

  /**
   * Sell the fees back into gas, once the float has fallen far enough.
   *
   * Runs after a relay rather than before one, so a withdrawal never waits on a
   * swap. Failures are swallowed: a sweep that cannot run leaves the relayer
   * exactly as it was, and the next quote will still say the float is thin.
   *
   * "Swallowed" has to mean all of them. The balance read below used to sit
   * outside the try, so an endpoint that blinked between carrying a spend and
   * deciding whether to sweep rejected this promise — and this runs after the
   * spend has already been answered, where there is no caller left to tell.
   */
  async function maybeSweep(): Promise<void> {
    if (sweeping || feeTokens.size === 0) return;
    sweeping = true;
    try {
      const float = await publicClient(net).getBalance({ address: account.address });
      if (floatHighWater === 0n) floatHighWater = float;
      if (float > floatHighWater / SWEEP_AT_FRACTION) return;

      console.log(`  float at ${float} wei, past half of ${floatHighWater} — selling fees back into gas`);
      const report = await sweepToGas(net, account, [...feeTokens]);
      for (const s of report.sold) {
        console.log(`  sold ${s.amountIn} ${s.symbol} -> ~${s.ethOut} wei  ${s.hash}`);
      }
      for (const s of report.skipped) {
        console.log(`  kept ${s.symbol}: ${s.reason}`);
      }
      const gained = report.floatAfter - report.floatBefore;
      console.log(`  float ${report.floatBefore} -> ${report.floatAfter} wei (${gained >= 0n ? "+" : ""}${gained})`);
      // The mark follows the float up, so the next sweep waits for the next
      // real decline rather than firing again on the same shortfall.
      if (report.floatAfter > floatHighWater / SWEEP_AT_FRACTION) floatHighWater = report.floatAfter;
    } catch (e) {
      console.warn(`  sweep failed: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      sweeping = false;
    }
  }

  // Requests currently doing upstream work. Distinct from `queued`, which
  // counts transactions: everything expensive about a request happens before it
  // ever reaches the queue, so the queue cannot bound it.
  let inflight = 0;

  const server = createServer((req, res) => {
    void (async () => {
      if (inflight >= MAX_INFLIGHT) {
        onEvent({ kind: "rejected", reason: "too many requests in flight" });
        send(res, 429, { error: "Relayer is busy — retry shortly." });
        return;
      }
      inflight += 1;
      try {
        const url = new URL(req.url ?? "/", "http://relay");
        if (req.method === "GET" && url.pathname === "/quote") {
          // ?op=trade sizes the quote for an atomic trade's gas instead of a spend's.
          const gasUnits = url.searchParams.get("op") === "trade" ? gasPerTrade(net) : GAS_PER_SPEND;
          // ?token=0x… prices the fee in that ERC-20 via the venue quoter; the
          // fee leg of a spend pays in the spend's own token. Validated before
          // anything upstream is asked, so a malformed address costs nothing.
          const tokenParam = url.searchParams.get("token");
          const token = tokenParam && tokenParam !== "0" ? (tokenParam as Address) : null;
          if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Bad token address.");
          const feeWei = await feeNow(net, opts.marginPct, gasUnits);
          const fee = token ? await feeInToken(net, token, feeWei) : feeWei;

          // A relayer that cannot pay for the spend it is quoting would take the
          // job and then fail to submit it. Declining here instead lets the
          // caller fall back to its own wallet while it still can.
          //
          // The float only refills for native-coin spends: an ERC-20 fee arrives
          // as that token and nothing converts it back to gas yet, so this is
          // the line that says when that day has come.
          const float = await publicClient(net).getBalance({ address: account.address });
          const spendsLeft = feeWei > 0n ? float / feeWei : 0n;
          if (float < feeWei) {
            onEvent({ kind: "rejected", reason: "out of gas float" });
            send(res, 503, {
              error: "This relayer is out of gas and cannot carry a spend right now.",
            });
            return;
          }
          if (spendsLeft <= LOW_FLOAT_SPENDS) {
            console.warn(
              `  relayer float is low: ${float} wei, about ${spendsLeft} spend${spendsLeft === 1n ? "" : "s"} left`,
            );
          }

          onEvent({ kind: "quote", feeWei });
          send(res, 200, {
            relayer: account.address,
            feeWei: feeWei.toString(),
            token: token ?? "0",
            fee: fee.toString(),
            chainId: net.chainId,
            pool,
            // Public anyway, and the number anyone routing through this relayer
            // wants before they depend on it.
            floatWei: float.toString(),
            spendsLeft: spendsLeft.toString(),
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/relay") {
          const raw = await readBody(req, 2 * 1024 * 1024);
          const parsed = JSON.parse(raw) as { spend?: never; ciphertexts?: [string, string]; proof?: string };
          const spend = decodeSpend(parsed.spend as never);
          const proof = parsed.proof;
          const cts = parsed.ciphertexts;
          if (typeof proof !== "string" || !/^0x[0-9a-fA-F]+$/.test(proof)) throw new Error("Bad proof.");
          if (!Array.isArray(cts) || cts.length !== 2 || cts.some((c) => !/^0x[0-9a-fA-F]+$/.test(c))) {
            throw new Error("Bad ciphertexts.");
          }

          // The fee leg must actually pay this relayer, in the spend's own
          // token, enough to cover the gas it is about to spend. Non-native
          // fees are priced through the venue quoter.
          if (spend.relayer !== BigInt(account.address)) throw new Error("Spend does not pay this relayer.");
          if (spend.token > (1n << 160n) - 1n) throw new Error("Bad token in spend.");
          // Before pricing, not after. Pricing an ERC-20 fee is five upstream
          // calls, and a relayer with a full queue is going to refuse this
          // request either way — so a flood of spends it cannot carry should
          // cost it nothing to turn away.
          if (queued >= MAX_QUEUE) {
            onEvent({ kind: "rejected", reason: "queue full" });
            send(res, 429, { error: "Relayer is busy — retry shortly." });
            return;
          }
          const floorWei = await feeNow(net, 0);
          const floor =
            spend.token === 0n
              ? floorWei
              : await feeInToken(net, `0x${spend.token.toString(16).padStart(40, "0")}` as Address, floorWei);
          if (spend.fee < floor) {
            throw new Reprove(`Fee too low: the spend pays ${spend.fee}, gas costs ${floor}. Re-quote and reprove.`);
          }

          queued += 1;
          const job = chain.then(async () => {
            let receipt;
            try {
              // Dry-run against current state first: an invalid proof or a
              // stale root rejects as a free eth_call, never as a reverted
              // transaction the relayer paid gas for.
              try {
                await simulateSpend(
                  net,
                  account.address,
                  spend,
                  cts as [`0x${string}`, `0x${string}`],
                  proof as `0x${string}`,
                );
                receipt = await submitSpend(
                  net,
                  account,
                  spend,
                  cts as [`0x${string}`, `0x${string}`],
                  proof as `0x${string}`,
                );
              } catch (e) {
                // Stale root, spent nullifier, invalid proof — the chain said no;
                // the spend has to be rebuilt against fresh state.
                throw new Reprove((e as Error).message);
              }
            } finally {
              queued -= 1;
            }
            onEvent({ kind: "relayed", hash: receipt.hash, feeWei: spend.fee, gasUsed: receipt.gasUsed });
            // The fee just landed in this token; remember it so a sweep knows
            // where to look, then see whether the float wants topping up.
            if (spend.token !== 0n) {
              feeTokens.add(`0x${spend.token.toString(16).padStart(40, "0")}` as Address);
            }
            send(res, 200, {
              hash: receipt.hash,
              gasUsed: receipt.gasUsed.toString(),
              blockNumber: receipt.blockNumber.toString(),
            });
            // Answered first, so no withdrawal waits on a swap — but awaited
            // inside the job, so the sweep still holds the queue. A detached
            // sweep sends its approve from the same account as the next spend
            // in line, and viem reads the nonce per transaction: two sends that
            // overlap read the same one, and one of them is thrown away.
            await maybeSweep();
          });
          chain = job.catch(() => {});
          await job;
          return;
        }

        if (req.method === "POST" && url.pathname === "/trade") {
          const raw = await readBody(req, 2 * 1024 * 1024);
          const t = decodeTrade(JSON.parse(raw) as never);

          // The unshield leg must pay the adapter (not us, not anyone else),
          // and its fee leg must pay this relayer a trade's worth of gas in
          // the spend's own token.
          const adapter = net.contracts.tradeAdapter;
          if (!adapter) throw new Error("This relayer's network has no trade adapter.");
          if (t.spend.recipient !== BigInt(adapter)) throw new Error("Trade spend does not pay the adapter.");
          if (t.spend.relayer !== BigInt(account.address)) throw new Error("Spend does not pay this relayer.");
          if (t.spend.token > (1n << 160n) - 1n) throw new Error("Bad token in spend.");
          // Before pricing, for the reason given on the same check in /relay.
          if (queued >= MAX_QUEUE) {
            onEvent({ kind: "rejected", reason: "queue full" });
            send(res, 429, { error: "Relayer is busy — retry shortly." });
            return;
          }
          const tradeFloorWei = await feeNow(net, 0, gasPerTrade(net));
          const tradeFloor =
            t.spend.token === 0n
              ? tradeFloorWei
              : await feeInToken(net, `0x${t.spend.token.toString(16).padStart(40, "0")}` as Address, tradeFloorWei);
          if (t.spend.fee < tradeFloor) {
            throw new Reprove(`Fee too low: the trade pays ${t.spend.fee}, gas costs ${tradeFloor}. Re-quote and reprove.`);
          }

          queued += 1;
          const job = chain.then(async () => {
            let receipt;
            try {
              try {
                await simulateTrade(net, account.address, t);
                receipt = await submitTrade(net, account, t);
              } catch (e) {
                throw new Reprove((e as Error).message);
              }
            } finally {
              queued -= 1;
            }
            onEvent({ kind: "relayed", hash: receipt.hash, feeWei: t.spend.fee, gasUsed: receipt.gasUsed });
            send(res, 200, {
              hash: receipt.hash,
              gasUsed: receipt.gasUsed.toString(),
              blockNumber: receipt.blockNumber.toString(),
            });
          });
          chain = job.catch(() => {});
          await job;
          return;
        }

        send(res, 404, { error: "Unknown endpoint. GET /quote, POST /relay, or POST /trade." });
      } catch (e) {
        const reason = (e as Error).message;
        onEvent({ kind: "rejected", reason });
        // 409 says "reprove against fresh state"; 400 says "malformed payload".
        // The operator's log keeps the whole message; the caller gets the half
        // that is about their spend rather than about this relayer's plumbing.
        send(res, e instanceof Reprove ? 409 : 400, { error: publicError(reason) });
      } finally {
        inflight -= 1;
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve({ close: () => server.close() }));
  });
}
