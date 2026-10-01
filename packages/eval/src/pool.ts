import { type Distribution, normalizeDist, P_FLOOR } from '@mimic/core';

/** Weighted log-linear pool (a normalised weighted geometric mean), each member floored at P_FLOOR. */
export function logPool(ms: Array<{ dist: Distribution; w: number }>, keys: string[]): Distribution {
  const total = ms.reduce((a, m) => a + m.w, 0) || 1;
  return normalizeDist(
    Object.fromEntries(
      keys.map((k) => [
        k,
        Math.exp(
          ms.reduce((a, m) => a + (m.w / total) * Math.log(Math.max(m.dist[k] ?? P_FLOOR, P_FLOOR)), 0),
        ),
      ]),
    ),
    keys,
  );
}

/** Weighted mixture of the members' distributions. */
export function linearPool(ms: Array<{ dist: Distribution; w: number }>, keys: string[]): Distribution {
  const total = ms.reduce((a, m) => a + m.w, 0) || 1;
  return normalizeDist(
    Object.fromEntries(keys.map((k) => [k, ms.reduce((a, m) => a + (m.w / total) * (m.dist[k] ?? 0), 0)])),
    keys,
  );
}
