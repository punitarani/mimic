/**
 * Label placement in screen space (ADR-0046). Labels keep one size at every zoom, so which ones fit changes as the
 * map zooms. Candidates are placed greedily in priority order, each below, above, right or left of its node, and a
 * label that would touch another label, another node or the canvas edge is left out (it shows on hover or when
 * zoomed in). So labels never overlap.
 */

export interface LabelCandidate {
  id: string;
  /** Node center and radius, in screen pixels. */
  x: number;
  y: number;
  r: number;
  text: string;
  w: number;
  h: number;
}

export interface PlacedLabel {
  id: string;
  text: string;
  /** Text position: `anchor` is SVG's text-anchor; y is the box's vertical center. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  box: Box;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 2;

export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

function hitsCircle(b: Box, c: { x: number; y: number; r: number }): boolean {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w));
  const ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
  return (c.x - nx) ** 2 + (c.y - ny) ** 2 < (c.r + 1) ** 2;
}

function options(c: LabelCandidate): Array<Omit<PlacedLabel, 'id' | 'text'>> {
  const below = { x: c.x - c.w / 2, y: c.y + c.r + PAD, w: c.w, h: c.h };
  const above = { x: c.x - c.w / 2, y: c.y - c.r - PAD - c.h, w: c.w, h: c.h };
  const right = { x: c.x + c.r + 4, y: c.y - c.h / 2, w: c.w, h: c.h };
  const left = { x: c.x - c.r - 4 - c.w, y: c.y - c.h / 2, w: c.w, h: c.h };
  const mid = (b: Box) => b.y + b.h / 2;
  return [
    { x: c.x, y: mid(below), anchor: 'middle', box: below },
    { x: c.x, y: mid(above), anchor: 'middle', box: above },
    { x: right.x, y: mid(right), anchor: 'start', box: right },
    { x: left.x + left.w, y: mid(left), anchor: 'end', box: left },
  ];
}

/**
 * Places up to `limit` labels from `candidates` (highest priority first). `nodes` are every drawn node, which labels
 * must not cover; `bounds` is the canvas and `avoid` the areas over it to keep clear (controls).
 */
export function placeLabels(
  candidates: LabelCandidate[],
  nodes: Array<{ id: string; x: number; y: number; r: number }>,
  bounds: { width: number; height: number },
  limit: number,
  avoid: Box[] = [],
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const c of candidates) {
    if (placed.length >= limit) break;
    if (c.x < 0 || c.y < 0 || c.x > bounds.width || c.y > bounds.height) continue;
    for (const o of options(c)) {
      const b = o.box;
      if (b.x < PAD || b.y < PAD || b.x + b.w > bounds.width - PAD || b.y + b.h > bounds.height - PAD)
        continue;
      if (placed.some((p) => boxesOverlap(p.box, b, PAD)) || avoid.some((a) => boxesOverlap(a, b, PAD)))
        continue;
      if (nodes.some((n) => n.id !== c.id && hitsCircle(b, n))) continue;
      placed.push({ id: c.id, text: c.text, ...o });
      break;
    }
  }
  return placed;
}
