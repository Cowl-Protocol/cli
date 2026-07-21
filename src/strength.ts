// A keystore is only as strong as the passphrase wrapping it. Offline brute
// force is the realistic attack on a stolen keystore file, so short passphrases
// are called out at the moment they are chosen.
export type Strength = { level: "weak" | "fair" | "strong"; hint?: string };

export function passphraseStrength(pass: string): Strength {
  const len = pass.length;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pass)).length;

  if (len < 10 || (len < 14 && classes < 2)) {
    return { level: "weak", hint: "Use 14+ characters, or four random words strung together." };
  }
  if (len < 16 && classes < 3) {
    return { level: "fair", hint: "Longer beats fancier. A few more random words is the easiest win." };
  }
  return { level: "strong" };
}
