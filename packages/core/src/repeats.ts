import type { QKind } from './types';

export interface ServedItem {
  questionId: string;
  seq: number;
  kind: QKind;
  repeatOf?: string | null;
  answered: boolean;
}

/**
 * PLAN §9.5 repeat schedule: after every `every` adaptive questions, re-serve an earlier answered anchor or
 * adaptive question verbatim, at least `minGap` session questions after it was first asked. `served` holds the
 * session's questions only; the gap counts them, not seqs, which questions written on the mimic page also take
 * (ADR-0027). Returns the question id to repeat, or null.
 */
export function pickRepeat(
  served: ServedItem[],
  cfg: { every: number; minGap: number },
  rng: () => number,
): string | null {
  if (cfg.every <= 0) return null;
  const sorted = [...served].sort((a, b) => a.seq - b.seq);
  let adaptiveSinceRepeat = 0;
  for (const s of sorted) {
    if (s.kind === 'repeat') adaptiveSinceRepeat = 0;
    else if (s.kind === 'adaptive') adaptiveSinceRepeat++;
  }
  if (adaptiveSinceRepeat < cfg.every) return null;
  const repeated = new Set(sorted.filter((s) => s.kind === 'repeat').map((s) => s.repeatOf));
  const eligible = sorted.filter(
    (s, i) =>
      (s.kind === 'anchor' || s.kind === 'adaptive') &&
      s.answered &&
      !repeated.has(s.questionId) &&
      sorted.length - i >= cfg.minGap,
  );
  if (!eligible.length) return null;
  return eligible[Math.floor(rng() * eligible.length)]!.questionId;
}
