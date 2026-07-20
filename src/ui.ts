// Branded terminal output for the Cowl CLI. Acid-green on dark, no dependencies
// beyond raw ANSI so the palette matches the brand exactly.

const useColor =
  process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.stdout.isTTY === true;

function wrap(open: string, close = "\x1b[0m") {
  return (s: string | number) => (useColor ? `${open}${s}${close}` : String(s));
}

// Brand palette (24-bit truecolor)
export const acid = wrap("\x1b[38;2;215;251;8m"); // #d7fb08
export const bone = wrap("\x1b[38;2;236;232;220m"); // #ece8dc
export const muted = wrap("\x1b[38;2;135;145;150m");
export const danger = wrap("\x1b[38;2;255;90;90m");
export const bold = wrap("\x1b[1m");
export const dim = wrap("\x1b[2m");

export function banner(): string {
  const mask = [
    "   ▟█████▙   ",
    "  ██ ▀█▀ ██  ",
    "  ██▄███▄██  ",
    "   ▀█████▀   ",
  ];
  const art = mask.map((l) => acid(l)).join("\n");
  return `\n${art}\n  ${bold(acid("COWL"))} ${muted("· trade unseen")}\n`;
}

export const symbols = {
  ok: () => acid("✓"),
  err: () => danger("✗"),
  dot: () => acid("●"),
  arrow: () => muted("→"),
  pending: () => muted("⧗"),
};

export function ok(msg: string) {
  console.log(`${symbols.ok()} ${msg}`);
}
export function info(msg: string) {
  console.log(`${symbols.arrow()} ${msg}`);
}
export function warn(msg: string) {
  console.log(`${acid("!")} ${msg}`);
}
export function fail(msg: string) {
  console.error(`${symbols.err()} ${danger(msg)}`);
}

// key: value row, aligned
export function row(label: string, value: string, pad = 14) {
  console.log(`  ${muted(label.padEnd(pad))} ${value}`);
}

export function heading(text: string) {
  console.log(`\n${bold(bone(text))}`);
}

/** Fail with a message and a non-zero exit code. */
export function die(msg: string, hint?: string): never {
  fail(msg);
  if (hint) console.error(`  ${muted(hint)}`);
  process.exit(1);
}
