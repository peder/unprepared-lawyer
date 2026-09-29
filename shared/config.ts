// Tunables from spec §16.
export const CONFIG = {
  READ_SECONDS: 30,
  OPENING_SECONDS: 60,
  CLOSING_SECONDS: 90,
  QUESTION_SECONDS: 45,
  OBJECTION_WINDOW_MS: 4000,
  PLAYER_OBJECTIONS: 3,
  PROSECUTION_DIRECT_QS: 3,
  PROSECUTION_CROSS_QS: 2,
  DEFENSE_QS: 3,
  JURY_MOMENTUM: 0.5,
  DELIBERATION_ROUNDS: 3,
  WARNING_THRESHOLD: 40,
  MISTRIAL_ZONE: 20,
  RECORD_TOKEN_BUDGET: 24000,
  JEV_MODEL: "jev-latest",
  JEV_TIMEOUT_MS: 3000,
  PATIENCE_DELTAS: {
    sustainedAgainstPlayer: -8,
    improper: -5,
    flagrant: -12,
    outrageous: -20,
    contradictedClaim: -4,
    overruledExcessObjection: -3,
    cleanExchange: 2,
  },
  TRUTH_DISTRIBUTION: { innocent: 0.34, guilty: 0.33, other_crime: 0.33 },
  MAX_WORDS_OPENING: 150,
  MAX_WORDS_CLOSING: 250,
} as const;

export type Config = typeof CONFIG;
