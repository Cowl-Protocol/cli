// Indicative fee schedule — mirrors the docs (fee-structure / fee-collector).
// Final rates are governance-set at launch.
export const FEES = [
  { name: "Protocol fee", rate: "~0.10%", when: "on each private trade", to: "fee collector" },
  { name: "Relayer fee", rate: "gas + margin", when: "when a relayer submits for you", to: "the relayer" },
  { name: "Unshield fee", rate: "~0.05%", when: "when moving out of the shielded pool", to: "fee collector" },
];

export const FEE_SPLIT = [
  { to: "Stakers", share: "50%" },
  { to: "Buyback & burn", share: "30%" },
  { to: "Treasury", share: "20%" },
];
