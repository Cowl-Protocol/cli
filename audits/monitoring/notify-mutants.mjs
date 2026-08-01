// Proves the notification channel speaks, stays quiet, and can fail.
//
//   node audits/monitoring/notify-mutants.mjs            # cases, then mutants
//   node audits/monitoring/notify-mutants.mjs alert-sent # one case, by name
//   node audits/monitoring/notify-mutants.mjs --cases    # cases only, no mutants
//
// Two halves, and the second is the one that matters.
//
// The cases stand a stub sink up on loopback, hand `scripts/notify.mjs` a fake
// watcher with a scripted exit code, and assert what arrived at the sink. The
// real watcher is never run: what is under test here is delivery, suppression
// and refusal, and pinning those to live chain state would make the harness
// fail for reasons that have nothing to do with the code it covers.
//
// The mutants then delete one defence at a time from a copy of notify.mjs and
// re-run the single case that defence exists for. A case that still passes with
// its defence removed was never testing anything, which is the whole reason
// every other harness in this tree has a mutant half.
//
// Nothing here touches the network or the chain. Every request goes to
// 127.0.0.1, so this runs in CI beside the rest.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../..");
const NOTIFY = join(CLI, "scripts/notify.mjs");

// The mutant is a sibling copy rather than an edit of the original. The
// relayer and watcher harnesses mutate their target in place and restore it in
// a finally, and both carry a paragraph about what happens when that restore
// does not run. A copy has no restore to get wrong: the worst outcome of a
// killed run is a stray dotfile, and the original is never opened for writing.
const MUTANT = join(CLI, "scripts/.notify-mutant.mjs");
const SOURCE = readFileSync(NOTIFY, "utf8");

const WORK = mkdtempSync(join(tmpdir(), "cowl-notify-"));
const cleanup = () => {
  rmSync(MUTANT, { force: true });
  rmSync(WORK, { recursive: true, force: true });
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    console.error(`\n${sig} — temporary files removed.`);
    process.exit(2);
  });
}

// ------------------------------------------------------------ fake watchers ---
/** A watcher that prints `out` and exits `code`. `sleepMs` makes it hang. */
function fakeWatcher(name, { out, code, sleepMs = 0 }) {
  const path = join(WORK, `${name}.mjs`);
  writeFileSync(
    path,
    [
      `process.stdout.write(${JSON.stringify(out)});`,
      sleepMs ? `await new Promise((r) => setTimeout(r, ${sleepMs}));` : "",
      `process.exit(${code});`,
    ].join("\n"),
  );
  return path;
}

const TURNSTILE = `
Robinhood Chain (robinhood-mainnet, chain 4663)
  pool 0x6f98666e0000000000000000000000000000006a3E
  ALERT  TURNSTILE SHORT on ETH
         pooledValue 100
         balance     40
1 alert. Read them before doing anything else.
`;
const SWAP = `
Robinhood Chain (robinhood-mainnet, chain 4663)
  ALERT  shield VERIFIER SWAP PENDING
         proposed verifier 0x000000000000000000000000000000000000dEaD
1 alert. Read them before doing anything else.
`;
const CLEAN = `
Robinhood Chain (robinhood-mainnet, chain 4663)
  ok     owner unchanged
All clear.
`;
const CANNOT = `
Robinhood Chain (robinhood-mainnet, chain 4663)
  UNCHECKED  0x0000000000000000000000000000000000000000: HTTP request failed
Nothing alerting, but 1 check could not run.
`;

const W = {
  alert: fakeWatcher("alert", { out: TURNSTILE, code: 1 }),
  swap: fakeWatcher("swap", { out: SWAP, code: 1 }),
  clean: fakeWatcher("clean", { out: CLEAN, code: 0 }),
  cannot: fakeWatcher("cannot", { out: CANNOT, code: 2 }),
  hang: fakeWatcher("hang", { out: "starting\n", code: 0, sleepMs: 12_000 }),
  // 60 kB of alarm, to prove the body is cut to the sink's limit rather than
  // rejected wholesale by it.
  huge: fakeWatcher("huge", { out: `  ALERT  TURNSTILE SHORT on ETH\n${"x".repeat(60_000)}\n`, code: 1 }),
};

// ------------------------------------------------------------- the stub sink ---
/** Records every POST. `mode` decides how it answers. */
function sink(mode = "ok") {
  const seen = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ path: req.url, body, type: req.headers["content-type"] });
        if (mode === "fail") {
          res.writeHead(500);
          res.end("no");
        } else if (mode === "redirect" && req.url !== "/elsewhere") {
          res.writeHead(302, { location: "/elsewhere" });
          res.end();
        } else {
          res.writeHead(200);
          res.end("ok");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

// Which copy of notify.mjs the cases run. The mutant half repoints this and
// puts it back, so every case is reused verbatim against the mutated build
// rather than reimplemented for it.
let ENTRY = NOTIFY;

function runNotify(script, { args = [], env = {}, entry = ENTRY } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "--script", script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let stateSeq = 0;
const freshState = () => join(WORK, `state-${(stateSeq += 1)}.json`);

// ----------------------------------------------------------------- the cases ---
// Each returns { ok, why }. `why` is printed only when it fails, because a
// passing harness that explains itself at length is a harness nobody reads.
const CASES = {
  // Something to look at reaches the sink, and the alarm's own words survive
  // the trip — a notification that says "check the logs" is a log entry.
  "alert-sent": async () => {
    const s = await sink();
    const r = await runNotify(W.alert, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() } });
    s.server.close();
    return {
      ok: s.seen.length === 1 && s.seen[0].body.includes("TURNSTILE SHORT") && r.code === 1,
      why: `${s.seen.length} posted, exit ${r.code}`,
    };
  },

  // A clean run says nothing at all. The channel is only worth reading if
  // arriving in it means something.
  "clean-silent": async () => {
    const s = await sink();
    const r = await runNotify(W.clean, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() } });
    s.server.close();
    return { ok: s.seen.length === 0 && r.code === 0, why: `${s.seen.length} posted, exit ${r.code}` };
  },

  // …unless asked, because a heartbeat that stops arriving is the only
  // dead-man's signal available without an external account.
  heartbeat: async () => {
    const s = await sink();
    const r = await runNotify(W.clean, {
      args: ["--heartbeat"],
      env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() },
    });
    s.server.close();
    return {
      ok: s.seen.length === 1 && s.seen[0].body.includes("all clear") && r.code === 0,
      why: `${s.seen.length} posted, exit ${r.code}`,
    };
  },

  // "Could not check" is not "nothing wrong", and it is not silence either.
  "unchecked-sent": async () => {
    const s = await sink();
    const r = await runNotify(W.cannot, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() } });
    s.server.close();
    return {
      ok: s.seen.length === 1 && s.seen[0].body.includes("could not check") && r.code === 2,
      why: `${s.seen.length} posted, exit ${r.code}`,
    };
  },

  // A pending swap alarms for seven days. Sending it every tick is how a
  // channel becomes wallpaper.
  "repeat-suppressed": async () => {
    const s = await sink();
    const state = freshState();
    const env = { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: state, COWL_WATCH_REPEAT_MINUTES: "60" };
    const first = await runNotify(W.alert, { env });
    const second = await runNotify(W.alert, { env });
    s.server.close();
    return {
      ok: s.seen.length === 1 && first.code === 1 && second.code === 1,
      why: `${s.seen.length} posted across two identical runs`,
    };
  },

  // A second alarm beside the first is new information, cooldown or not.
  "digest-change": async () => {
    const s = await sink();
    const env = { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState(), COWL_WATCH_REPEAT_MINUTES: "60" };
    await runNotify(W.alert, { env });
    await runNotify(W.swap, { env });
    s.server.close();
    return {
      ok: s.seen.length === 2 && s.seen[1].body.includes("VERIFIER SWAP PENDING"),
      why: `${s.seen.length} posted, last body ${s.seen.at(-1)?.body.slice(0, 60)}`,
    };
  },

  // Going quiet after an alert is indistinguishable from the alert clearing,
  // so clearing is said out loud.
  recovery: async () => {
    const s = await sink();
    const env = { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() };
    await runNotify(W.alert, { env });
    const back = await runNotify(W.clean, { env });
    s.server.close();
    return {
      ok: s.seen.length === 2 && s.seen[1].body.includes("RECOVERED") && back.code === 0,
      why: `${s.seen.length} posted, exit ${back.code}, last body ${s.seen.at(-1)?.body.slice(0, 60)}`,
    };
  },

  // A 502 between here and Discord must not eat an alert, and when every
  // attempt fails the run must not exit 1 as though someone had been told.
  "retry-then-fail": async () => {
    const s = await sink("fail");
    const r = await runNotify(W.alert, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() } });
    s.server.close();
    return { ok: s.seen.length === 3 && r.code === 3, why: `${s.seen.length} attempts, exit ${r.code}` };
  },

  // The URL is the credential. Plaintext is refused before a byte leaves.
  "plaintext-refused": async () => {
    const s = await sink();
    // 127.0.0.2 is on this machine and off the loopback exception, so a
    // mutant that drops the guard fails fast against a closed port instead of
    // reaching for the network. The verdict is the refusal message, not the
    // exit code, precisely because both paths end at 3.
    const r = await runNotify(W.alert, {
      env: { COWL_WATCH_WEBHOOK: "http://127.0.0.2:1/hook", COWL_WATCH_STATE: freshState() },
    });
    s.server.close();
    return {
      ok: r.code === 3 && /must be https/.test(r.out) && s.seen.length === 0,
      why: `exit ${r.code}, said: ${r.out.trim().split("\n").at(-1)}`,
    };
  },

  // A 3xx asks for the same secret to be handed to a different host.
  "redirect-refused": async () => {
    const s = await sink("redirect");
    const r = await runNotify(W.alert, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() } });
    s.server.close();
    const followed = s.seen.some((x) => x.path === "/elsewhere");
    return { ok: !followed && r.code === 3, why: `followed=${followed}, exit ${r.code}, ${s.seen.length} requests` };
  },

  // A hung watcher under a timer is the failure that sends nothing forever.
  //
  // The elapsed check is the assertion that matters and it is not decoration.
  // Setting a deadline flag without killing the child still produces the right
  // message and the right exit code — eventually — and "eventually" is the
  // whole bug: the unit stays active, the next tick stacks behind it, and the
  // alert arrives whenever the hung process feels like returning. The fake
  // watcher sleeps for 12 seconds against a 1 second deadline, so only a run
  // that actually killed it comes back inside 5.
  "watcher-timeout": async () => {
    const s = await sink();
    const began = Date.now();
    const r = await runNotify(W.hang, {
      args: ["--timeout", "1"],
      env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: freshState() },
    });
    const elapsed = Date.now() - began;
    s.server.close();
    return {
      ok: s.seen.length === 1 && s.seen[0].body.includes("timed out") && r.code === 2 && elapsed < 5_000,
      why: `${s.seen.length} posted, exit ${r.code}, took ${(elapsed / 1000).toFixed(1)}s`,
    };
  },

  // Over the sink's limit the whole POST is rejected, so the alert long enough
  // to matter would be the one that never arrives.
  truncated: async () => {
    const s = await sink();
    const r = await runNotify(W.huge, {
      env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_SINK: "discord", COWL_WATCH_STATE: freshState() },
    });
    s.server.close();
    const content = s.seen.length === 1 ? JSON.parse(s.seen[0].body).content : "";
    return {
      ok: s.seen.length === 1 && content.length <= 1900 && content.includes("TURNSTILE SHORT") && r.code === 1,
      why: `${content.length} chars posted, exit ${r.code}`,
    };
  },

  // Two runs sharing a state file is how a cooldown swallows an alert nobody
  // has seen. The second one steps aside instead, and says so.
  "concurrent-run-skipped": async () => {
    const s = await sink();
    const state = freshState();
    writeFileSync(`${state}.lock`, "999999\n");
    const r = await runNotify(W.alert, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: state } });
    s.server.close();
    return {
      ok: s.seen.length === 0 && r.code === 0 && /another run holds/.test(r.out),
      why: `${s.seen.length} posted, exit ${r.code}`,
    };
  },

  // …and a lock nothing can clear is a watcher that quietly stopped watching.
  // A killed run leaves one behind, so an old one must be takeable.
  "stale-lock-taken": async () => {
    const s = await sink();
    const state = freshState();
    const lock = `${state}.lock`;
    writeFileSync(lock, "999999\n");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = await runNotify(W.alert, { env: { COWL_WATCH_WEBHOOK: s.url, COWL_WATCH_STATE: state } });
    s.server.close();
    return {
      ok: s.seen.length === 1 && r.code === 1 && /stale lock/.test(r.out),
      why: `${s.seen.length} posted, exit ${r.code}`,
    };
  },

  // The same rule the relayer passphrase file is held to on the same box.
  "webhook-file-perms": async () => {
    const s = await sink();
    const file = join(WORK, "hook.txt");
    writeFileSync(file, s.url);
    chmodSync(file, 0o644);
    const r = await runNotify(W.alert, {
      env: { COWL_WATCH_WEBHOOK_FILE: file, COWL_WATCH_STATE: freshState(), COWL_WATCH_WEBHOOK: "" },
    });
    s.server.close();
    return {
      ok: r.code === 3 && /readable beyond its owner/.test(r.out) && s.seen.length === 0,
      why: `exit ${r.code}, ${s.seen.length} posted`,
    };
  },
};

// --------------------------------------------------------------- the mutants ---
// find | replace | the case that must break. A mutant whose `find` no longer
// appears in notify.mjs is a hard error, not a pass: a harness that silently
// stops mutating anything reports a clean sweep forever.
const MUTANTS = [
  [
    "no-https-guard",
    'if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {',
    "if (false) {",
    "plaintext-refused",
  ],
  ["no-perms-check", "if (mode !== 0) {", "if (false) {", "webhook-file-perms"],
  ["no-cooldown", "const withinCooldown = sameAsLast", "const withinCooldown = false && sameAsLast", "repeat-suppressed"],
  ["digest-blind", "const sameAsLast = state.digest === digest;", "const sameAsLast = true;", "digest-change"],
  ["no-recovery", 'const recovered = LEVEL === "clean" && wasAlerting;', "const recovered = false;", "recovery"],
  ["no-retry", "const ATTEMPTS = 3;", "const ATTEMPTS = 1;", "retry-then-fail"],
  ["no-kill", 'child.kill("SIGKILL");', "/* not killed */", "watcher-timeout"],
  ["no-truncation", "if (text.length <= limit) return text;", "return text;", "truncated"],
  ["follows-redirects", 'redirect: "error",', 'redirect: "follow",', "redirect-refused"],
  ["no-lock", "if (!takeLock()) {", "if (false) {", "concurrent-run-skipped"],
  ["lock-never-stale", "if (age > TIMEOUT_MS + 60_000) {", "if (false) {", "stale-lock-taken"],
  [
    "silent-failure",
    "if (reason !== null && (sinkError || (!DRY_RUN && !delivered?.ok))) process.exit(3);",
    "",
    "retry-then-fail",
  ],
];

// ------------------------------------------------------------------- run it ---
const argv = process.argv.slice(2);
const CASES_ONLY = argv.includes("--cases");
const only = argv.find((a) => !a.startsWith("--")) ?? null;
if (only && !(only in CASES)) {
  console.error(`No case named ${only}. Known: ${Object.keys(CASES).join(", ")}`);
  cleanup();
  process.exit(2);
}

let failed = 0;
try {
  const chosen = only ? [only] : Object.keys(CASES);
  console.log(`${"CASE".padEnd(24)} RESULT`);
  console.log("-".repeat(72));
  const results = {};
  for (const name of chosen) {
    const { ok, why } = await CASES[name]();
    results[name] = ok;
    if (!ok) failed += 1;
    console.log(`${name.padEnd(24)} ${ok ? "pass" : `FAIL — ${why}`}`);
  }

  if (!only && !CASES_ONLY) {
    if (failed > 0) {
      console.error("\nCases failed before any mutation. Nothing below would mean anything.");
    } else {
      console.log(`\n${"MUTANT".padEnd(20)} ${"RESULT".padEnd(10)} CASE THAT MUST BREAK`);
      console.log("-".repeat(72));
      for (const [name, find, replace, caseName] of MUTANTS) {
        if (!SOURCE.includes(find)) {
          console.error(`${name.padEnd(20)} STALE      "${find.slice(0, 40)}…" is no longer in notify.mjs`);
          failed += 1;
          continue;
        }
        writeFileSync(MUTANT, SOURCE.replace(find, replace));
        // The mutated copy is what runs, through the same case, unchanged.
        ENTRY = MUTANT;
        const { ok } = await CASES[caseName]();
        ENTRY = NOTIFY;
        rmSync(MUTANT, { force: true });

        const caught = !ok;
        if (!caught) failed += 1;
        console.log(`${name.padEnd(20)} ${(caught ? "caught" : "SURVIVED").padEnd(10)} ${caseName}`);
      }
    }
  }
} finally {
  cleanup();
}

console.log("-".repeat(72));
console.log(failed === 0 ? "All green." : `${failed} failure${failed === 1 ? "" : "s"}.`);
process.exit(failed > 0 ? 1 : 0);
