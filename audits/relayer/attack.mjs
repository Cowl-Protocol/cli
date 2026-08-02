// The relayer daemon, attacked.
//
//   node audits/relayer/attack.mjs             every case
//   node audits/relayer/attack.mjs tier-spread one, by name
//
// Every other control in `audits/` reads code that runs when somebody we can
// see calls it. This one reads the only piece of the protocol that holds a
// funded key and answers the open internet, where the caller is anonymous and
// the payload is theirs. So the cases are written the way an attacker would
// reach it: no proof, no wallet, no cost, and one specific lie per case.
//
// The chain underneath is a stub (`harness.mjs`), so nothing here touches a
// network and the whole suite is safe in CI. What the stub buys is the thing a
// live run cannot give: an exact count of what one anonymous request costs the
// relayer upstream.
//
// A case fails loudly and the run exits 1. `mutants.mjs` deletes each defence
// in turn and requires the paired case to notice, because a suite that has only
// ever passed has demonstrated nothing.
import { withRelayer, overlappingSends, TOKEN } from "./harness.mjs";

const ONLY = process.argv[2];
const results = [];

/** The bounds the daemon is built to hold, restated so a drift is visible. */
const MAX_INFLIGHT = 16;
const MAX_QUEUE = 8;
/** A quote priced in a token: gas price, four tiers, then the float. */
const QUOTE_COST = 6;

function ok(name, detail) {
  results.push({ name, pass: true, detail });
  console.log(`  ok    ${name.padEnd(16)} ${detail}`);
}
function fail(name, detail) {
  results.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name.padEnd(16)} ${detail}`);
}

const CASES = {
  // -------------------------------------------------------------- control ---
  // Every case below asserts that something is refused. Without this one they
  // would all pass against a relayer that refused everything, including a
  // relayer that was simply broken.
  async control(r) {
    const q = await (await r.quote(`?token=${TOKEN}`)).json();
    if (q.error) return fail("control", `an honest quote was refused: ${q.error}`);
    const res = await r.relaySpend(q.fee);
    if (res.status !== 200) {
      return fail("control", `an honest spend paying the quoted fee was refused ${res.status}`);
    }
    ok("control", `honest quote ${q.fee}, spend carried`);
  },

  // ------------------------------------------------------- adapter-unknown ---
  // A trade's unshield leg names who the pool pays. If a relayer will submit
  // one paying any address, it becomes a machine for funding transfers to
  // strangers out of somebody else's shielded balance. The set of addresses it
  // will pay has to come from source, never from the request.
  async "adapter-unknown"(r) {
    const res = await r.relayTrade("0x000000000000000000000000000000000000dEaD");
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) return fail("adapter-unknown", "a trade paying 0x…dEaD was carried");
    if (!/adapter/i.test(body.error ?? "")) {
      return fail("adapter-unknown", `refused ${res.status}, but not for the adapter: ${body.error}`);
    }
    ok("adapter-unknown", `refused ${res.status}: ${body.error}`);
  },

  // ------------------------------------------------------- adapter-legacy ---
  // The other direction, and the one that bit on 2026-08-02. Clients and
  // relayers do not upgrade in the same minute, so an adapter the network used
  // to run must keep working — otherwise shipping a new adapter breaks gasless
  // trading for everyone who has not updated, and rolling back breaks it for
  // everyone who has.
  //
  // This trade is refused too, further down, because its proof is nonsense.
  // What it must NOT be refused for is the adapter.
  async "adapter-legacy"(r) {
    const res = await r.relayTrade("0xD0D74be38C0B99EBa6465e9F512c3F78EE2d1f3B");
    const body = await res.json().catch(() => ({}));
    if (/does not pay the adapter/i.test(body.error ?? "")) {
      return fail("adapter-legacy", "the previous adapter was refused — an upgrade would cut off every client mid-migration");
    }
    ok("adapter-legacy", `previous adapter accepted past the check (then ${res.status}: ${(body.error ?? "").slice(0, 40)})`);
  },

  // ----------------------------------------------------------- tier-spread ---
  // Anyone can create a pool at a fee tier that has none and seed it with a
  // dust position at a price of their choosing. The daemon scans all four tiers
  // and takes the cheapest quote, so one dust pool sets the fee for every spend
  // in that token and the relayer carries the gas for all of them.
  async "tier-spread"(r) {
    const honest = BigInt((await (await r.quote(`?token=${TOKEN}`)).json()).fee);

    r.chain.poisonTier = 100; // three honest tiers left untouched
    r.chain.poisonQuote = 3n;
    const poisoned = await (await r.quote(`?token=${TOKEN}`)).json();
    if (!poisoned.error) {
      return fail(
        "tier-spread",
        `one dust pool moved the quoted fee ${honest} -> ${poisoned.fee}`,
      );
    }

    // And the floor on /relay is the same conversion, so it has to refuse too —
    // a quote nobody has to ask for is not the door that matters.
    const res = await r.relaySpend(3);
    if (res.status === 200) return fail("tier-spread", "a spend paying 3 base units was carried");
    ok("tier-spread", `dust pool refused, spend paying 3 refused ${res.status}`);
  },

  // ---------------------------------------------------------- quote-flood ---
  // A quote never enters the transaction queue, so MAX_QUEUE bounds nothing
  // about it. Each one costs a gas price, four quoter calls and a balance read.
  async "quote-flood"(r) {
    const N = 50;
    const upstream = await r.counting(async () => {
      const res = await Promise.all(Array.from({ length: N }, () => r.quote(`?token=${TOKEN}`)));
      r.statuses = res.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
    });
    const ceiling = MAX_INFLIGHT * QUOTE_COST;
    if (upstream.length > ceiling) {
      return fail(
        "quote-flood",
        `${N} anonymous quotes cost ${upstream.length} upstream calls, over the ${ceiling} the in-flight cap allows`,
      );
    }
    if (!r.statuses[429]) return fail("quote-flood", "nothing was turned away");
    ok(
      "quote-flood",
      `${N} at once -> ${upstream.length} upstream calls (cap ${ceiling}), ${r.statuses[429]} refused`,
    );
  },

  // ------------------------------------------------------------ full-queue ---
  // With the queue already full the relayer is going to refuse the next spend
  // whatever it says, so pricing it first is work an anonymous caller gets for
  // free — five upstream calls per refusal, on an endpoint that rate-limits.
  async "full-queue"(r) {
    let release;
    r.chain.stall = new Promise((s) => (release = s));
    // Fill it. These hang inside simulate and never answer until released.
    const held = Array.from({ length: MAX_QUEUE }, () => r.relaySpend(10n ** 18n));
    try {
      await new Promise((s) => setTimeout(s, 300));

      const upstream = await r.counting(async () => {
        r.overflow = await r.relaySpend(10n ** 18n);
      });
      if (r.overflow.status !== 429) {
        return fail("full-queue", `a spend past the queue got ${r.overflow.status}, not 429`);
      }
      if (upstream.length > 0) {
        return fail(
          "full-queue",
          `refusing one spend past a full queue still cost ${upstream.length} upstream calls`,
        );
      }
      ok("full-queue", `refused with ${upstream.length} upstream calls`);
    } finally {
      // Always, and before returning either way. Eight requests still inside
      // the daemon when the harness tears it down is how this case used to hang
      // instead of reporting, and a failing case is exactly when that happens.
      r.chain.stall = null;
      release();
      await Promise.allSettled(held);
    }
  },

  // -------------------------------------------------------------- rpc-leak ---
  // viem writes the endpoint URL and the outgoing request body into the message
  // of any transport failure, and the daemon handed that message straight to
  // whoever asked. `deploy/relayer` tells operators to pin their own endpoint.
  async "rpc-leak"(r) {
    r.chain.down = true;
    const res = await r.quote();
    const body = await res.text();
    r.chain.down = false;
    if (body.includes("127.0.0.1") || /URL\s*:/i.test(body)) {
      return fail("rpc-leak", `the endpoint came back to the caller: ${body.slice(0, 120)}`);
    }
    if (!body.includes("error")) return fail("rpc-leak", "the caller was told nothing at all");
    ok("rpc-leak", `refused without naming the endpoint: ${JSON.parse(body).error.split("\n")[0]}`);
  },

  // ------------------------------------------------------------ wide-field ---
  // The body limit is 2MB and the wire carries bigints as decimal strings, so
  // an anonymous caller could ask the relayer's single thread to parse a two
  // million digit number. Nothing on this wire is wider than a uint256.
  async "wide-field"(r) {
    const wide = { ...r.spend(0), value: "9".repeat(1_000_000) };
    const started = process.hrtime.bigint();
    const res = await r.relay({ spend: wide, ciphertexts: ["0xaa", "0xbb"], proof: "0xcc" });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const body = await res.json();
    if (res.status !== 400 || !/Bad value/.test(body.error ?? "")) {
      return fail("wide-field", `a million-digit value was accepted for parsing (${res.status}, ${ms.toFixed(0)}ms)`);
    }
    ok("wide-field", `refused on width in ${ms.toFixed(0)}ms`);
  },

  // --------------------------------------------------------- survive-blip ---
  // A spend is answered from inside its queue job, and the job keeps working
  // after that: it records the fee token and decides whether to sweep. An
  // endpoint that blinks in that window throws where there is no caller left to
  // answer, the handler's catch answers a request that already got its 200, and
  // writing headers twice is an exception with nothing above it to catch it.
  // One blip, and the daemon and everything queued behind it are gone.
  async "survive-blip"(r) {
    const carried = await r.relaySpend(10n ** 18n);
    if (carried.status !== 200) return fail("survive-blip", "the setup spend was not carried");

    // /relay reads no balance, so refusing that one method blinks the endpoint
    // in exactly the window between the response and the sweep decision.
    r.chain.failMethod = "eth_getBalance";
    const blipped = await r.relaySpend(10n ** 18n);
    if (blipped.status !== 200) return fail("survive-blip", `the second spend got ${blipped.status}`);
    await new Promise((s) => setTimeout(s, 150)); // let the after-work land
    r.chain.failMethod = null;

    // Two spends carried, and neither logged as refused. A daemon that answered
    // the 200 and then took its own catch would report a spend it did carry.
    const relayed = r.events.filter((e) => e.kind === "relayed").length;
    const rejected = r.events.filter((e) => e.kind === "rejected");
    if (relayed !== 2 || rejected.length > 0) {
      return fail(
        "survive-blip",
        `${relayed} relayed, ${rejected.length} rejected (${rejected.map((x) => x.reason.split("\n")[0]).join("; ")})`,
      );
    }

    // And it is still answering, which is the other half.
    const after = await r.quote();
    if (after.status !== 200) return fail("survive-blip", `the daemon stopped answering (${after.status})`);
    ok("survive-blip", "carried both spends through the blip, neither miscounted, still answering");
  },

  // ----------------------------------------------------------- sweep-nonce ---
  // The sweep sends its own transactions from the account the next spend in
  // line is about to send from. viem reads the nonce per transaction, so two
  // flows that overlap read the same one and the chain keeps only one of them.
  async "sweep-nonce"(r) {
    r.chain.wethHeld = 10n ** 18n; // gives the sweep something to unwrap
    r.chain.delay = { eth_getTransactionCount: 150 };

    // The first relay only records the high-water mark, and it records it after
    // answering — so the float has to stay high until that read has landed, or
    // the mark is taken at the lowered figure and no sweep ever runs.
    await r.relaySpend(10n ** 18n);
    await new Promise((s) => setTimeout(s, 200));
    r.chain.float = 10n ** 17n; // now past half the mark

    const upstream = await r.counting(async () => {
      await r.relaySpend(10n ** 18n);
      // The one behind it in the queue, which is what a detached sweep races.
      await r.relaySpend(10n ** 18n);
      await new Promise((s) => setTimeout(s, 400));
    });
    const sends = upstream.filter((m) => m === "eth_sendRawTransaction").length;
    if (sends < 3) return fail("sweep-nonce", `only ${sends} transactions went out; the sweep never ran`);
    if (overlappingSends(upstream)) {
      return fail("sweep-nonce", "the sweep and the next spend read the same nonce");
    }
    ok("sweep-nonce", `${sends} transactions incl. the sweep's, no two sharing a nonce read`);
  },
};

const names = ONLY ? [ONLY] : Object.keys(CASES);
if (ONLY && !CASES[ONLY]) {
  console.error(`No case named ${ONLY}. Have: ${Object.keys(CASES).join(", ")}`);
  process.exit(2);
}

console.log(`Relayer daemon, ${names.length} case${names.length === 1 ? "" : "s"}, against a stub chain.\n`);
for (const name of names) {
  // A fresh daemon per case: the in-flight cap, the queue and the sweep's
  // high-water mark are all per-process state, and a case that inherited them
  // would pass or fail on what the case before it did.
  try {
    // A case that hangs is a case that reports nothing, and under a mutant that
    // reads as "the suite could not run" rather than as a verdict. The deadline
    // is far above the slowest case, which waits on deliberate delays.
    await Promise.race([
      withRelayer((r) => CASES[name](r)),
      new Promise((_, no) => setTimeout(() => no(new Error("case timed out after 60s")), 60_000).unref()),
    ]);
  } catch (e) {
    fail(name, `threw: ${(e?.message ?? e).toString().split("\n")[0]}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} held.`);
if (failed.length) {
  console.log(`Failed: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
