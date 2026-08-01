// One mutation harness at a time.
//
// Four harnesses in this tree prove their suites can fail by breaking
// first-party source **in place** and restoring it afterwards: the pool
// invariants, the circuits, the relayer daemon, and the notification channel.
// Each restores from a copy it took at the start, and each is careful about
// signals, because a killed harness that leaves the source mutated is worse
// than one that never ran.
//
// None of them was careful about the other three.
//
// Two running at once is not a hypothetical. It happened while re-verifying
// this tree: `npm run test:circuits` was started while the circuit mutant
// harness was mid-run, and the clean suite reported two failures that were not
// real. That is the harmless version. The harmful one is two *mutating*
// harnesses overlapping, because the second one's "original" is the first one's
// mutant — and its restore then writes a weakened file back as the baseline. A
// circuit missing one constraint, restored as though it were the source, is
// exactly the quiet failure this whole tree exists to catch.
//
// So they take a lock. A directory rather than a file, because `mkdir` is
// atomic in both node and bash and the shell harness has to use the same one.
//
// Refusing is the right behaviour rather than waiting: these runs take minutes,
// and a developer who started the wrong one wants to be told, not blocked.
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const LOCK = join(CLI, ".mutation.lock");

// The slowest harness here is the circuits', which compiles and proves 17 times.
// An hour is far past any honest run and far short of leaving a crashed one to
// block the tree forever.
const STALE_MS = 60 * 60 * 1000;

/** Take the lock or exit 2. Releases on normal exit and on a signal. */
export function takeMutationLock(name) {
  try {
    mkdirSync(LOCK);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let owner = "an unknown harness";
    try {
      owner = readFileSync(join(LOCK, "owner"), "utf8").trim();
    } catch {
      // A lock directory with no owner file is still a lock.
    }
    const age = Date.now() - statSync(LOCK).mtimeMs;
    if (age < STALE_MS) {
      console.error(`Another mutation harness is running: ${owner}.`);
      console.error("These edit first-party source in place, and two at once can restore a mutated file");
      console.error(`as the baseline. Wait for it, or remove ${LOCK} if you are sure it is dead.`);
      process.exit(2);
    }
    console.error(`Stale lock from ${owner}, ${Math.round(age / 60000)} minutes old. Taking it over.`);
  }
  writeFileSync(join(LOCK, "owner"), `${name}, pid ${process.pid}\n`);

  const release = () => {
    try {
      rmSync(LOCK, { recursive: true, force: true });
    } catch {
      // Nothing useful to do at exit; the staleness rule covers it.
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(2);
    });
  }
}
