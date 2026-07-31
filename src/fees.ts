// Indicative fee schedule — mirrors the docs (fee-structure / fee-collector).
// Final rates are governance-set at launch.
export const FEES = [
  { name: "Protocol fee", rate: "~0.10%", when: "on each private trade", to: "fee collector" },
  { name: "Relayer fee", rate: "gas + margin", when: "when a relayer submits for you", to: "the relayer" },
  { name: "Unshield fee", rate: "~0.05%", when: "when moving out of the shielded pool", to: "fee collector" },
];

// Destinations are settled; the proportions are not, so none are printed here.
// A split that adds up is the kind of number people quote back, and inventing
// one to fill a table is how a placeholder becomes a promise.
export const FEE_SPLIT = [
  { to: "Buyback & burn", purpose: "buys $COWL on the market and burns it" },
  { to: "Treasury", purpose: "grants, audits, development" },
];
