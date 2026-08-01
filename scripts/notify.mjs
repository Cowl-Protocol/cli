// Tells a person what the watcher found.
//
//   node scripts/notify.mjs                        run the watch, speak if it matters
//   node scripts/notify.mjs --heartbeat            speak even when everything is fine
//   node scripts/notify.mjs --dry-run              print what would be sent, send nothing
//   node scripts/notify.mjs -- --network robinhood-mainnet
//
// Exit codes: 0 clean, 1 something to look at, 2 could not check — the watcher's
// own codes, passed through — and **3 nobody was told**. That fourth code is the
// point of this file. A check whose result never reached a person has the same
// operational value as a check that never ran, and the two must not look alike
// from a timer's perspective.
//
// ---------------------------------------------------------------------------
// Why this is a wrapper and not a flag on the watcher
//
// scripts/watch-pool.mjs holds seven alarms that audits/monitoring/mutants.mjs
// proves can fire. Adding outbound HTTP to that file would widen the surface of
// the one component whose job is to be trustworthy, and every future change to
// delivery would land in a file whose alarms are pinned. So delivery lives here,
// the watcher is spawned as a child and is not modified, and its exit codes are
// the entire interface between the two.
//
// The seam is `--script`, an argument rather than a shell string: the child is
// spawned with an argv array and no shell, so a path can never become a command.
// audits/monitoring/notify-mutants.mjs uses it to stand fake watchers up.
//
// ---------------------------------------------------------------------------
// What it refuses to do
//
// PLAINTEXT       the sink URL is a credential — a Discord webhook, a Telegram
//                 bot token, a Slack hook are all secret in their path. Over
//                 http:// that credential crosses the wire in the clear and so
//                 does every address in the alert. https:// is required, and
//                 loopback is the single exception so the harness can stub a
//                 sink without one.
//
// REDIRECTS       a 3xx is a request to hand the same secret to a different
//                 host. `redirect: "error"` refuses; a webhook that legitimately
//                 redirects does not exist.
//
// GROUP-READABLE  COWL_WATCH_WEBHOOK_FILE is rejected unless it is 0600 or
// SECRETS         tighter. The relayer's passphrase file on the same box already
//                 holds that line and this one is no less a secret.
//
// LOGGING THE URL the sink is identified by host and kind in every line this
//                 file prints, never by URL. systemd journals are readable by
//                 more people than /etc is.
//
// ---------------------------------------------------------------------------
// Repetition, and the two ways silence lies
//
// A timer running every fifteen minutes against a pending verifier swap would
// send the same alert 672 times over the seven days the delay lasts, and the
// 673rd is the one nobody reads. So a repeat of the *same* digest is suppressed
// for COWL_WATCH_REPEAT_MINUTES. A digest that changes is always sent, because
// a second alarm arriving beside the first is new information.
//
// The mirror of that: going quiet after an alert is indistinguishable from the
// alert clearing. So a run that comes back clean after a run that did not sends
// a RECOVERED line, whether or not anyone asked for heartbeats.
//
// What this file cannot do is notice its own absence — a timer that stops firing
// sends nothing, and nothing is what a healthy quiet run looks like too. The
// honest answer to that costs an external account, which is what the Tenderly
// row in audits/monitoring/README.md is still open for. The cheap half is
// `--heartbeat` on a daily timer: a heartbeat that fails to arrive is the
// dead-man's signal, and it is only a signal if somebody notices it missing.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");

// ------------------------------------------------------------- arguments ---
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  if (at < 0) return null;
  const v = argv[at + 1];
  // The same bug audits/monitoring/README.md records as I-01 on the watcher:
  // indexOf returns -1 when the flag is absent and argv[-1 + 1] is argv[0]. It
  // is guarded here rather than reinvented.
  if (v === undefined || v.startsWith("--")) {
    console.error(`${flag} needs a value after it.`);
    process.exit(2);
  }
  return v;
};

const HEARTBEAT = has("--heartbeat");
const DRY_RUN = has("--dry-run");
const SCRIPT = valueOf("--script") ?? join(CLI, "scripts/watch-pool.mjs");
const TIMEOUT_MS = Number(valueOf("--timeout") ?? process.env.COWL_WATCH_TIMEOUT ?? 300) * 1000;
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error("--timeout needs a positive number of seconds.");
  process.exit(2);
}

// Everything after a bare `--` belongs to the watcher, plus any flag this file
// does not own, so `--network robinhood-mainnet` works with or without it.
const OWN = new Set(["--heartbeat", "--dry-run", "--script", "--timeout"]);
const sep = argv.indexOf("--");
const passthrough =
  sep >= 0
    ? argv.slice(sep + 1)
    : argv.filter((a, i) => {
        if (OWN.has(a)) return false;
        if (OWN.has(argv[i - 1]) && !a.startsWith("--")) return false; // the value of one of ours
        return true;
      });

const STATE = process.env.COWL_WATCH_STATE ?? join(CLI, ".watch-state.json");
const REPEAT_MINUTES = Number(process.env.COWL_WATCH_REPEAT_MINUTES ?? 60);
if (!Number.isFinite(REPEAT_MINUTES) || REPEAT_MINUTES < 0) {
  console.error("COWL_WATCH_REPEAT_MINUTES must be a non-negative number of minutes.");
  process.exit(2);
}

// ------------------------------------------------------------ the sink ---
// Per-sink body caps, one under each service's documented limit. Over the limit
// the whole POST is rejected, so an alert long enough to matter would be the
// one that never arrives.
const CAPS = { slack: 3500, discord: 1900, telegram: 3900, ntfy: 3900, json: 8000 };

function sinkKind(url) {
  const override = process.env.COWL_WATCH_SINK;
  if (override) {
    if (!(override in CAPS)) {
      throw new Error(`COWL_WATCH_SINK must be one of ${Object.keys(CAPS).join(", ")}.`);
    }
    return override;
  }
  const h = url.hostname.toLowerCase();
  if (h === "hooks.slack.com") return "slack";
  if (h === "discord.com" || h === "discordapp.com" || h.endsWith(".discord.com")) return "discord";
  if (h === "api.telegram.org") return "telegram";
  if (h === "ntfy.sh" || h.endsWith(".ntfy.sh")) return "ntfy";
  return "json";
}

function isLoopback(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** Resolve the sink, or explain why there is none. Never returns the URL in an
 *  error string: the path is the credential. */
function loadSink() {
  let raw = process.env.COWL_WATCH_WEBHOOK ?? null;
  const file = process.env.COWL_WATCH_WEBHOOK_FILE ?? null;
  if (!raw && file) {
    if (!existsSync(file)) throw new Error(`COWL_WATCH_WEBHOOK_FILE ${file} does not exist.`);
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) {
      throw new Error(
        `COWL_WATCH_WEBHOOK_FILE ${file} is readable beyond its owner (mode ${(statSync(file).mode & 0o777)
          .toString(8)
          .padStart(3, "0")}). chmod 600 it — the URL is the credential.`,
      );
    }
    raw = readFileSync(file, "utf8").trim();
  }
  if (!raw) {
    throw new Error("No sink configured. Set COWL_WATCH_WEBHOOK or COWL_WATCH_WEBHOOK_FILE.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The configured sink is not a URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(
      `The sink must be https. ${url.protocol}//${url.host} would put the webhook credential and every ` +
        "address in the alert on the wire in the clear.",
    );
  }
  const kind = sinkKind(url);
  if (kind === "telegram" && !process.env.COWL_WATCH_CHAT_ID) {
    throw new Error("A Telegram sink needs COWL_WATCH_CHAT_ID.");
  }
  return { url, kind, host: url.host };
}

let sink = null;
let sinkError = null;
try {
  sink = loadSink();
} catch (e) {
  // Recorded, not fatal — the watcher still runs, and its output still reaches
  // the journal. Delivery failure is reported at the end as exit 3.
  sinkError = e.message;
}

// ------------------------------------------------------------------- lock ---
// A timer firing every fifteen minutes against a chain whose RPCs regularly
// take a minute will eventually start a run while the last one is still going.
// Two concurrent runs share a state file, and the loser's write decides what
// the next run thinks was already sent — which is how a cooldown swallows an
// alert nobody has seen.
//
// The lock is deliberately not a hard failure. The check IS happening, in the
// other process, and it will notify; exiting non-zero here would page a person
// about scheduling.
const LOCK = `${STATE}.lock`;
let held = false;

function takeLock() {
  try {
    mkdirSync(dirname(LOCK), { recursive: true });
    writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") {
      console.error(`  ·      could not take ${LOCK}: ${e.message}. Continuing without it.`);
      return true;
    }
    // A killed run leaves its lock behind, and a lock nothing can clear is a
    // watcher that stops watching. Anything older than one whole run plus a
    // minute cannot belong to a live process doing useful work.
    const age = Date.now() - statSync(LOCK).mtimeMs;
    if (age > TIMEOUT_MS + 60_000) {
      console.error(`  ·      stale lock ${Math.round(age / 1000)}s old, taking it over.`);
      writeFileSync(LOCK, `${process.pid}\n`);
      return true;
    }
    return false;
  }
}

if (!takeLock()) {
  console.log(`  ·      another run holds ${LOCK}. Skipping this tick; that run will notify.`);
  process.exit(0);
}
held = true;
// Covers process.exit() as well as falling off the end, which matters because
// every exit in this file is explicit.
process.on("exit", () => {
  if (held) rmSync(LOCK, { force: true });
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (held) rmSync(LOCK, { force: true });
    process.exit(2);
  });
}

// -------------------------------------------------------- run the watcher ---
// A watcher that hangs is the failure mode a timer handles worst: the unit
// stays active, the next tick is skipped or stacks behind it, and nothing is
// ever sent. It gets a deadline, and blowing it is itself notifiable.
const MAX_OUTPUT = 256 * 1024;

function runWatcher() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...passthrough], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let truncated = false;
    const take = (d) => {
      if (out.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      out += d;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 2, out: `${out}\ncould not start ${SCRIPT}: ${e.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated) out += `\n… output truncated at ${MAX_OUTPUT} bytes.`;
      resolve({ code: timedOut ? 2 : (code ?? 2), out, timedOut });
    });
  });
}

const run = await runWatcher();
process.stdout.write(run.out.endsWith("\n") || run.out === "" ? run.out : `${run.out}\n`);

// ------------------------------------------------------------ classify it ---
const LEVEL = run.timedOut ? "unchecked" : run.code === 0 ? "clean" : run.code === 1 ? "alert" : "unchecked";

// The alarm labels the watcher printed, which is what makes two alerting runs
// "the same" or "different". Deliberately not the whole output: balances and
// leaf counts move between runs and would make every repeat look new, which is
// the failure that trains people to ignore the channel.
const alarms = [...run.out.matchAll(/^\s*ALERT\s{2}(.+)$/gm)].map((m) => m[1].trim());
const unchecked = [...run.out.matchAll(/^\s*UNCHECKED\s{2}(.+?):/gm)].map((m) => m[1].trim());
const digest = createHash("sha256")
  .update(JSON.stringify({ LEVEL, alarms, unchecked, timedOut: run.timedOut }))
  .digest("hex")
  .slice(0, 16);

// --------------------------------------------------------------- the state ---
function loadState() {
  if (!existsSync(STATE)) return {};
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    // A corrupt state file must never suppress an alert. Losing the dedupe
    // memory costs one duplicate message; honouring a garbage file could cost
    // the message itself.
    return {};
  }
}

function saveState(next) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    console.error(`  ·      could not write ${STATE}: ${e.message}. Repeats will not be suppressed.`);
  }
}

const state = loadState();
const now = Date.now();
const wasAlerting = state.level === "alert" || state.level === "unchecked";
const recovered = LEVEL === "clean" && wasAlerting;
const sameAsLast = state.digest === digest;
const withinCooldown = sameAsLast && typeof state.sentAt === "number" && now - state.sentAt < REPEAT_MINUTES * 60_000;

let reason = null;
if (LEVEL === "clean") {
  if (recovered) reason = "recovered";
  else if (HEARTBEAT) reason = "heartbeat";
} else if (withinCooldown) {
  reason = null;
} else {
  reason = sameAsLast ? "repeat" : "new";
}

// --------------------------------------------------------------- compose ---
function subjectFor() {
  if (recovered) return "COWL watch — RECOVERED, all clear";
  if (LEVEL === "clean") return "COWL watch — all clear";
  if (run.timedOut) return `COWL watch — the watcher timed out after ${TIMEOUT_MS / 1000}s`;
  if (LEVEL === "alert") {
    const n = alarms.length;
    return `COWL watch — ${n} alert${n === 1 ? "" : "s"}: ${alarms.join(", ") || "see body"}`;
  }
  return `COWL watch — could not check${unchecked.length ? `: ${unchecked.join(", ")}` : ""}`;
}

const CUT = "\n… truncated, see journal.";

function cap(text, limit) {
  if (text.length <= limit) return text;
  // The tail is where the watcher's summary line lives, and the head is where
  // the alarms are. The head wins: an alert's first lines say what to do. The
  // marker is measured rather than guessed, because a body one character over
  // the sink's limit is rejected exactly as hard as one that is double it.
  return `${text.slice(0, limit - CUT.length)}${CUT}`;
}

const subject = subjectFor();
const body = cap(`${subject}\n\n${run.out.trim()}`, sink ? CAPS[sink.kind] : CAPS.json);

function payloadFor(kind) {
  if (kind === "slack") return { json: { text: body } };
  if (kind === "discord") return { json: { content: body } };
  if (kind === "telegram") {
    return {
      json: { chat_id: process.env.COWL_WATCH_CHAT_ID, text: body, disable_web_page_preview: true },
    };
  }
  if (kind === "ntfy") {
    return {
      text: body,
      headers: { Title: subject.slice(0, 200), Priority: LEVEL === "alert" ? "urgent" : "default" },
    };
  }
  return {
    json: {
      source: "cowl-watch",
      level: recovered ? "recovered" : LEVEL,
      subject,
      body,
      exitCode: run.code,
      alarms,
      digest,
      at: new Date(now).toISOString(),
    },
  };
}

// ------------------------------------------------------------------ send ---
const ATTEMPTS = 3;
const RETRY_ON = new Set([408, 425, 429, 500, 502, 503, 504]);

async function post() {
  const { json, text, headers } = payloadFor(sink.kind);
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(sink.url, {
        method: "POST",
        // A 3xx asks us to send the same secret to a different host.
        redirect: "error",
        headers: json ? { "content-type": "application/json", ...headers } : { "content-type": "text/plain", ...headers },
        body: json ? JSON.stringify(json) : text,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, attempts: attempt };
      last = `HTTP ${res.status}`;
      if (!RETRY_ON.has(res.status)) return { ok: false, attempts: attempt, why: last };
      const after = Number(res.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) {
        await new Promise((r) => setTimeout(r, Math.min(after, 30) * 1000));
        continue;
      }
    } catch (e) {
      // A redirect refusal lands here too, and it is not worth retrying — the
      // sink will redirect again. Undici reports it as a bare "fetch failed"
      // with the real reason on `cause`, so both are read.
      last = e.cause?.message ? `${e.message} (${e.cause.message})` : e.message;
      if (/redirect/i.test(last)) return { ok: false, attempts: attempt, why: `refused a redirect: ${last}` };
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false, attempts: ATTEMPTS, why: last ?? "unknown" };
}

let delivered = null;
if (reason === null) {
  const why = LEVEL === "clean" ? "nothing to say" : `same alarms as ${new Date(state.sentAt).toISOString()}`;
  console.log(`  ·      not notifying: ${why}`);
} else if (sinkError) {
  console.error(`  ALERT  no notification sent: ${sinkError}`);
} else if (DRY_RUN) {
  console.log(`  ·      would notify ${sink.kind} at ${sink.host} (${reason})`);
  console.log(body.split("\n").map((l) => `         ${l}`).join("\n"));
} else {
  delivered = await post();
  if (delivered.ok) {
    console.log(`  ok     notified ${sink.kind} at ${sink.host} (${reason}, attempt ${delivered.attempts})`);
  } else {
    console.error(
      `  ALERT  could not notify ${sink.kind} at ${sink.host} after ${delivered.attempts} attempt(s): ${delivered.why}`,
    );
  }
}

// The digest is remembered on every run so a change is detectable. `sentAt`
// only moves when something was actually sent — a failed delivery must not
// start a cooldown on a message nobody received, and neither must a dry run,
// which by definition told nobody.
saveState({
  digest,
  level: LEVEL,
  ranAt: new Date(now).toISOString(),
  ...(delivered?.ok
    ? { sentAt: now, sentDigest: digest }
    : state.sentAt
      ? { sentAt: state.sentAt, sentDigest: state.sentDigest }
      : {}),
});

// Delivery failure outranks the watcher's own code on purpose: exit 1 means a
// person has been told there is something to look at, and that is exactly what
// has not happened here. A misconfigured sink exits 3 even under --dry-run,
// because checking the configuration is what a dry run is for.
if (reason !== null && (sinkError || (!DRY_RUN && !delivered?.ok))) process.exit(3);
process.exit(run.code);
