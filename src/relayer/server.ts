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
import { poolAddress, simulateSpend, submitSpend } from "../shielded/contract.js";
import { decodeSpend } from "./client.js";

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

/** Observed spend gas is ~4.6M; quote a spend's worth with headroom. */
const GAS_PER_SPEND = 5_000_000n;

/** Spends waiting in line before new ones get a 429. Spends serialize on the
 * pool root, so a long queue only grows stale — better to say busy early. */
const MAX_QUEUE = 8;

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

async function feeNow(net: NetworkDef, marginPct: number): Promise<bigint> {
  const gasPrice = await publicClient(net).getGasPrice();
  return (gasPrice * GAS_PER_SPEND * BigInt(100 + marginPct)) / 100n;
}

/**
 * Price `feeWei` worth of gas in `token`, by asking the venue quoter how much
 * of the token buys exactly that much WETH. The fee leg of an ERC-20 spend
 * pays in that token, so this is what makes relaying one worth the gas.
 */
async function feeInToken(net: NetworkDef, token: Address, feeWei: bigint): Promise<bigint> {
  const quoter = net.contracts.quoter;
  const weth = net.contracts.weth;
  if (!quoter || !weth) throw new Error("This relayer has no price source for that token — withdraw the native coin, or drop --relay.");
  const { result } = await publicClient(net).simulateContract({
    address: quoter,
    abi: QUOTER_ABI,
    functionName: "quoteExactOutputSingle",
    args: [{ tokenIn: token, tokenOut: weth, amount: feeWei, fee: 3000, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

function send(res: ServerResponse, status: number, body: unknown): void {
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

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://relay");
        if (req.method === "GET" && url.pathname === "/quote") {
          const feeWei = await feeNow(net, opts.marginPct);
          // ?token=0x… prices the fee in that ERC-20 via the venue quoter; the
          // fee leg of a spend pays in the spend's own token.
          const tokenParam = url.searchParams.get("token");
          const token = tokenParam && tokenParam !== "0" ? (tokenParam as Address) : null;
          if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Bad token address.");
          const fee = token ? await feeInToken(net, token, feeWei) : feeWei;
          onEvent({ kind: "quote", feeWei });
          send(res, 200, {
            relayer: account.address,
            feeWei: feeWei.toString(),
            token: token ?? "0",
            fee: fee.toString(),
            chainId: net.chainId,
            pool,
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
          const floorWei = await feeNow(net, 0);
          const floor =
            spend.token === 0n
              ? floorWei
              : await feeInToken(net, `0x${spend.token.toString(16).padStart(40, "0")}` as Address, floorWei);
          if (spend.fee < floor) {
            throw new Reprove(`Fee too low: the spend pays ${spend.fee}, gas costs ${floor}. Re-quote and reprove.`);
          }
          if (queued >= MAX_QUEUE) {
            onEvent({ kind: "rejected", reason: "queue full" });
            send(res, 429, { error: "Relayer is busy — retry shortly." });
            return;
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

        send(res, 404, { error: "Unknown endpoint. GET /quote or POST /relay." });
      } catch (e) {
        const reason = (e as Error).message;
        onEvent({ kind: "rejected", reason });
        // 409 says "reprove against fresh state"; 400 says "malformed payload".
        send(res, e instanceof Reprove ? 409 : 400, { error: reason });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve({ close: () => server.close() }));
  });
}
