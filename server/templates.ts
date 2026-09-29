// Templated judge / log lines (spec §11, §10.4). Never LLM — fixed strings.
export const JUDGE_LINES = {
  sustained: "Sustained.",
  overruled: "Overruled.",
  disregard: "The jury will disregard that.",
  treadCarefully: "I'll allow it, but tread carefully, counsel.",
  warning: "Counsel, approach the bench. One more outburst like that and I will hold you in contempt.",
  mistrialGranted: "Mistrial granted. This case will be transferred to another lawyer at the firm.",
  strikeNote: "[STRICKEN — jury instructed to disregard]",
} as const;

export function deliberationLine(jurorLabel: string, jurorId: string): string {
  const beats = [
    `Juror ${jurorId} (${jurorLabel}) pounds the table.`,
    `Juror ${jurorId} (${jurorLabel}) re-reads their notes, frowning.`,
    `Juror ${jurorId} (${jurorLabel}) whispers to a neighbor.`,
  ];
  return beats[jurorId.charCodeAt(1) % beats.length];
}
