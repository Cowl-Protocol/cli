// The stub chain the relayer daemon is attacked against.
//
// The daemon is the real one — `startRelayServer` out of `src/relayer/server.ts`,
// bundled from source on every run so a mutant is picked up without a build
// step. Only the chain below it is fake, and it is fake in the two directions
// that matter: it answers deterministically, and it counts every RPC request
// the daemon makes. That count is the evidence for the amplification cases,
// which are otherwise invisible — a relayer under a flood looks fine from the
// outside right up until its endpoint starts refusing it.
//
// Nothing here reaches a network. The suite runs offline and is safe in CI.
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "../..");

/** The venue tiers the daemon scans, mirrored so a case can poison one. */
export const TIERS = [100, 500, 3000, 10000];

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const ADDR = {
  pool: "0x6f98666e9d05431dCd765AAa289a5E346AfA6a3E",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  router: "0xCaf681a66D020601342297493863E78C959E5cb2",
  adapter: "0x0b86f9d1D2E0Abc8ab7C7BE39498855E8F4a3A98",
  // An adapter this network used to run. A relayer keeps accepting it so
  // clients mid-upgrade still relay; anything outside the set is refused.
  adapterOld: "0xD0D74be38C0B99EBa6465e9F512c3F78EE2d1f3B",
};
export const TOKEN = "0x1111111111111111111111111111111111111111";

/** The honest price of a spend's gas, in the token, at every tier. */
const HONEST_QUOTE = 10n ** 18n;

/**
 * Stand the real daemon on loopback over a stub chain and hand `fn` the
 * controls. Everything is torn down in a finally, including on a thrown case,
 * because a leaked listener would make the next case fail for the wrong reason.
 */
export async function withRelayer(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "cowl-relay-audit-"));
  try {
    await esbuild.build({
      entryPoints: [join(CLI, "src/relayer/server.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: join(tmp, "server.mjs"),
      logLevel: "error",
    });
    await esbuild.build({
      entryPoints: [join(CLI, "node_modules/viem/_esm/accounts/index.js")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: join(tmp, "accounts.mjs"),
      logLevel: "error",
    });
    const { startRelayServer } = await import(join(tmp, "server.mjs"));
    const { privateKeyToAccount } = await import(join(tmp, "accounts.mjs"));

    // What the stub does differently, per case. Defaults are an honest chain.
    const chain = {
      /** null, or the tier whose dust pool answers `poisonQuote`. */
      poisonTier: null,
      poisonQuote: 3n,
      /** Refuse every RPC request, the way a dead endpoint would. */
      down: false,
      /**
       * Refuse one method and answer the rest. `/relay` never reads a balance
       * and the sweep decision does nothing else, so naming `eth_getBalance`
       * makes an endpoint blink in exactly the window after a spend has been
       * answered — which is the window with no caller left to tell.
       */
      failMethod: null,
      /** Native balance the daemon reads as its float. */
      float: 10n ** 18n,
      /** Nonzero makes the sweep find WETH to unwrap, which sends a tx. */
      wethHeld: 0n,
      /**
       * Held open, this makes the pool's own simulate hang, which is how a case
       * fills the transaction queue without needing eight real spends.
       */
      stall: null,
      /**
       * Milliseconds to hold a method before answering. A nonce read that takes
       * time is what makes an overlap between two flows observable rather than
       * a matter of which one the event loop happened to schedule first.
       */
      delay: {},
    };

    const calls = [];
    let nonce = 0;

    function result(method, params) {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x1234";
        case "eth_gasPrice":
          return "0x" + (10n ** 9n).toString(16);
        case "eth_getBalance":
          return "0x" + chain.float.toString(16);
        case "eth_blockNumber":
          return "0x1";
        case "eth_getTransactionCount":
          return "0x" + nonce.toString(16);
        case "eth_estimateGas":
          return "0x" + (5_000_000n).toString(16);
        case "eth_maxPriorityFeePerGas":
          return "0x0";
        case "eth_sendRawTransaction":
          nonce += 1;
          return "0x" + "11".repeat(32);
        case "eth_call": {
          const to = (params?.[0]?.to ?? "").toLowerCase();
          const data = params?.[0]?.data ?? "0x";
          // The pool's spend()/trade() take long calldata and return nothing.
          if (data.length >= 1000) return "0x";
          if (to === ADDR.quoter.toLowerCase()) {
            // quoteExact*Single((tokenIn,tokenOut,amount,fee,limit)) — fee is
            // the fourth word, which is how a case poisons exactly one tier.
            const tier = Number(BigInt("0x" + data.slice(10 + 64 * 3, 10 + 64 * 4)));
            const out = chain.poisonTier === tier ? chain.poisonQuote : HONEST_QUOTE;
            return "0x" + word(out) + word(0) + word(0) + word(0);
          }
          if (to === ADDR.weth.toLowerCase()) return "0x" + word(chain.wethHeld);
          // Any other read the sweep makes: no balance, no allowance.
          return "0x" + word(0);
        }
        case "eth_getBlockByNumber":
          return {
            number: "0x1", baseFeePerGas: "0x0", gasLimit: "0x2000000", timestamp: "0x1",
            hash: "0x" + "00".repeat(32), parentHash: "0x" + "00".repeat(32), transactions: [],
          };
        case "eth_getTransactionReceipt":
          return {
            transactionHash: "0x" + "11".repeat(32), blockNumber: "0x1",
            gasUsed: "0x" + (4_400_000n).toString(16), status: "0x1", logs: [],
            contractAddress: null, cumulativeGasUsed: "0x0", effectiveGasPrice: "0x1",
            from: "0x" + "00".repeat(20), to: "0x" + "00".repeat(20), transactionIndex: "0x0",
            blockHash: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), type: "0x2",
          };
        default:
          return null;
      }
    }

    const rpc = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          if (chain.down) {
            calls.push("refused");
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("the endpoint declined");
            return;
          }
          const parsed = JSON.parse(body);
          const batch = Array.isArray(parsed) ? parsed : [parsed];
          const out = [];
          for (const r of batch) {
            if (chain.failMethod === r.method) {
              calls.push(r.method);
              out.push({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "the endpoint declined" } });
              continue;
            }
            const answer = result(r.method, r.params);
            const held = chain.delay[r.method];
            if (held) await new Promise((s) => setTimeout(s, held));
            // A long-calldata eth_call is the pool's own simulate; holding it is
            // how a case keeps jobs in the queue.
            if (chain.stall && r.method === "eth_call" && (r.params?.[0]?.data ?? "").length >= 1000) {
              await chain.stall;
            }
            out.push({ jsonrpc: "2.0", id: r.id, result: answer });
          }
          const text = JSON.stringify(Array.isArray(parsed) ? out : out[0]);
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          res.end(text);
        })();
      });
    });
    await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
    const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;

    const account = privateKeyToAccount("0x" + "01".repeat(32));
    const net = {
      key: "stub",
      label: "Stub Chain",
      chainId: 4660,
      rpcUrl,
      explorer: "http://explorer.invalid",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 },
      testnet: true,
      tradeGas: 9_000_000n,
      contracts: {
        pool: ADDR.pool,
        weth: ADDR.weth,
        quoter: ADDR.quoter,
        swapRouter: ADDR.router,
        tradeAdapter: ADDR.adapter,
        tradeAdapterLegacy: [ADDR.adapterOld],
        feeTier: 500,
      },
    };

    // startRelayServer takes a port and never reports one back, so claim a free
    // one first rather than guessing at a fixed number two runs could collide on.
    const port = await new Promise((r) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });

    const events = [];
    const { close } = await startRelayServer(net, account, { port, marginPct: 25 }, (e) => events.push(e));

    /** A spend that is well formed and pays this relayer, in `token`. */
    const spend = (fee, token = TOKEN) => ({
      membershipRoot: "0x" + "00".repeat(32),
      nullifiers: ["0x" + "01".repeat(32), "0x" + "02".repeat(32)],
      commitments: ["0x" + "03".repeat(32), "0x" + "04".repeat(32)],
      newRoot: "0x" + "05".repeat(32),
      token: token === "native" ? "0" : BigInt(token).toString(),
      value: "0",
      fee: String(fee),
      recipient: "1",
      relayer: BigInt(account.address).toString(),
    });

    /**
     * One request, over a connection that is not kept alive.
     *
     * `fetch` pools its sockets, and a pooled socket holds the daemon's server
     * open long after the case is done — so `close()` waits on a connection
     * nobody is using and the harness hangs instead of reporting. `agent:
     * false` gives each request its own socket and closes it on the response.
     */
    const request = (path, init = {}) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path, method: init.method ?? "GET", agent: false, headers: init.headers },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () =>
              resolve({ status: res.statusCode, text: async () => body, json: async () => JSON.parse(body) }),
            );
          },
        );
        req.on("error", reject);
        if (init.body) req.write(init.body);
        req.end();
      });

    const api = {
      chain,
      calls,
      events,
      account,
      spend,
      /** Upstream RPC requests made while `fn` ran. */
      async counting(f) {
        const from = calls.length;
        await f();
        return calls.slice(from);
      },
      quote: (qs = "") => request(`/quote${qs}`),
      relay: (payload) =>
        request("/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      /** The default shape: a proven-looking spend paying `fee` in `token`. */
      relaySpend: (fee, token = TOKEN) =>
        api.relay({ spend: spend(fee, token), ciphertexts: ["0xaa", "0xbb"], proof: "0xcc" }),
      /** A trade whose unshield leg pays `recipient`. Everything past the
       *  adapter check is nonsense on purpose: what is under test is which
       *  addresses the relayer is willing to pay at all. */
      relayTrade: (recipient, fee = 1) =>
        request("/trade", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            spend: { ...spend(fee), recipient: BigInt(recipient).toString() },
            ciphertexts: ["0xaa", "0xbb"],
            spendProof: "0xcc",
            tokenOut: "0",
            amountOut: "1",
            poolFee: 500,
            shieldCommitment: "0x" + "06".repeat(32),
            shieldNewRoot: "0x" + "07".repeat(32),
            shieldCiphertext: "0xdd",
            shieldProof: "0xee",
          }),
        }),
    };

    try {
      return await fn(api);
    } finally {
      // `close()` alone stops new connections and then waits for the open ones,
      // and a case that fails early can leave requests in flight over sockets
      // fetch is keeping alive. That waits forever, and a harness that hangs
      // instead of reporting is worse than one that reports a failure.
      close();
      rpc.close();
      rpc.closeAllConnections?.();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Two transactions from one account overlap when the daemon reads the nonce
 * twice before either send lands — viem reads it per transaction, so both get
 * the same number and one is thrown away. That shape is visible in the call log
 * without decoding a raw transaction.
 */
export function overlappingSends(calls) {
  let pendingRead = false;
  for (const m of calls) {
    if (m === "eth_getTransactionCount") {
      if (pendingRead) return true;
      pendingRead = true;
    } else if (m === "eth_sendRawTransaction") {
      pendingRead = false;
    }
  }
  return false;
}
