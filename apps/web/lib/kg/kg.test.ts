import type { UiSnapshot } from '@mimic/core';
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  CATEGORIES,
  DEFAULT_THRESHOLD,
  filterGraph,
  labelOrder,
  type MapGraph,
  maxDegree,
} from './build';
import { isVague, parseWork, placeKey, sentenceCase, splitList, truncate } from './clean';
import { boxesOverlap, placeLabels } from './labels';
import { anchorsFor, type LayoutNode, layoutGraph } from './layout';
import { sampleFacets, sampleKg } from './sample';

const sample = () => buildGraph(sampleKg(), sampleFacets());
const byLabel = (g: MapGraph, label: string) => g.nodes.find((n) => n.label === label);
const edgeBetween = (g: MapGraph, a: string, b: string) => {
  const [x, y] = [byLabel(g, a)?.id, byLabel(g, b)?.id];
  return g.edges.find((e) => (e.source === x && e.target === y) || (e.source === y && e.target === x));
};

describe('label cleanup', () => {
  it('splits a company and role named in one label', () => {
    expect(parseWork('Slash — Software Engineer', 'org')).toEqual({
      org: 'Slash',
      roles: ['Software Engineer'],
      aliases: [],
    });
    expect(parseWork('NOCO — Software Engineer (2019–2021)', 'org')).toMatchObject({
      org: 'NOCO',
      roles: ['Software Engineer'],
    });
    expect(parseWork('Software Engineer - Stripe', 'org')).toMatchObject({ org: 'Stripe' });
    expect(parseWork('Senior Software Engineer at Handshake | ex-Slash | Penn', 'role')).toMatchObject({
      org: 'Handshake',
      roles: ['Senior Software Engineer'],
    });
    expect(parseWork('Prospify — Co-Founder & CTO', 'org').roles).toEqual(['Co-Founder', 'CTO']);
    // A page title chains the person's name, the title and the company: the name is neither.
    expect(parseWork('Jane Doe - Senior Software Engineer - Handshake | LinkedIn', 'role')).toEqual({
      org: 'Handshake',
      roles: ['Senior Software Engineer'],
      aliases: [],
    });
  });

  it('keeps an aside as an alias and drops dates', () => {
    expect(parseWork('Handshake (Handshake AI)', 'org')).toEqual({
      org: 'Handshake',
      roles: [],
      aliases: ['Handshake AI'],
    });
    expect(parseWork('Acme, 2019–2021', 'org').org).toBe('Acme');
  });

  it('splits lists, with or without a "Label:" prefix', () => {
    expect(splitList('Technologies: Azure, Docker, Kubernetes')).toEqual({
      subtype: 'Technologies',
      items: ['Azure', 'Docker', 'Kubernetes'],
    });
    expect(splitList('Python, Go, and Rust').items).toEqual(['Python', 'Go', 'Rust']);
    // A phrase with a comma in it is one thing.
    expect(splitList('writing code for data pipelines, mostly in Python').items).toHaveLength(1);
    // A title with a colon is one thing; a list's name with one item is still a list.
    expect(splitList('Star Wars: The Clone Wars')).toEqual({ items: ['Star Wars: The Clone Wars'] });
    expect(splitList('Languages: Python')).toEqual({ subtype: 'Languages', items: ['Python'] });
  });

  it('gives one key to spellings of one place', () => {
    const key = placeKey('San Francisco, California');
    expect(placeKey('San Francisco, California.')).toBe(key);
    expect(placeKey('San Francisco, CA')).toBe(key);
    expect(placeKey('Greater San Francisco Bay Area')).toBe(key);
    expect(placeKey('Oakland, California')).not.toBe(key);
  });

  it('drops fragments that name nothing', () => {
    for (const s of [
      'self-described balanced or flexible planner',
      'broad platform role over deep specialization',
      'job involving complex tech',
      'broad platform role over',
      'things',
    ])
      expect(isVague(s), s).toBe(true);
    for (const s of [
      'Rock climbing',
      'PyTorch',
      'System design',
      'San Francisco, California',
      'R',
      'C',
      'Role-playing games',
      'Series A',
    ])
      expect(isVague(s), s).toBe(false);
    expect(isVague('x')).toBe(true);
    // Names from a profile keep their hedge words.
    expect(isVague('General Motors')).toBe(true);
    for (const s of ['General Motors', 'Broad Institute', 'General Manager'])
      expect(isVague(s, { name: true }), s).toBe(false);
  });

  it('sentence-cases phrases but not names', () => {
    expect(sentenceCase('sci-fi novels')).toBe('Sci-fi novels');
    expect(sentenceCase('iOS apps')).toBe('iOS apps');
    expect(sentenceCase('PyTorch')).toBe('PyTorch');
    expect(truncate('Writing code for data pipelines', 22)).toBe('Writing code for data…');
    expect(truncate('Short', 22)).toBe('Short');
  });
});

describe('buildGraph', () => {
  it('drops the person hub and splits composite labels into entities', () => {
    const g = sample();
    expect(g.nodes.some((n) => n.label === 'You')).toBe(false);
    for (const n of g.nodes) expect(n.label).not.toMatch(/[:—]|\(|Technologies|Programming languages/);
    for (const label of ['Slash', 'NOCO', 'Software Engineer', 'Azure', 'Docker', 'Python', 'PyTorch'])
      expect(byLabel(g, label), label).toBeDefined();
  });

  it('dedupes, with one category per node', () => {
    const g = sample();
    const places = g.nodes.filter((n) => n.kind === 'Place');
    expect(places.map((p) => p.label)).toEqual(['San Francisco, California']);
    expect(places[0]!.short).toBe('San Francisco');
    // "Handshake (Handshake AI)" from the profile and "Handshake" from an answer are one node, from both sources.
    const handshake = g.nodes.filter((n) => /handshake/i.test(n.label));
    expect(handshake).toHaveLength(1);
    expect(handshake[0]!.sources).toEqual(['linkedin.com', 'Your answers']);
    // "Software Engineer" at Slash and at NOCO is one role.
    expect(g.nodes.filter((n) => n.label === 'Software Engineer')).toHaveLength(1);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    const categories = new Set(CATEGORIES.map((c) => c.id));
    for (const n of g.nodes) expect(categories.has(n.category)).toBe(true);
  });

  it('merges by alias in any order, but not two companies that share an aside', () => {
    const P = 'p';
    const U = 'https://www.linkedin.com/in/x';
    const org = (id: string, label: string, predicate: string, url?: string) => ({
      node: {
        id,
        type: 'Organization',
        label,
        source: url ? 'search' : 'reflection',
        ...(url ? { url } : {}),
      },
      edge: { src: P, dst: id, predicate, weight: 0.8, ...(url ? { url } : { evidence: [2] }) },
    });
    const parts = [
      org('a', 'Google (Intern)', 'workedFor', U),
      org('b', 'Meta (Intern)', 'workedFor', U),
      org('c', 'Handshake', 'worksFor'),
      org('d', 'Handshake AI', 'worksFor', 'https://handshake.com/about'),
      org('e', 'Handshake (Handshake AI)', 'worksFor', U),
    ];
    const g = buildGraph({
      nodes: [{ id: P, type: 'Person', label: 'You' }, ...parts.map((p) => p.node)],
      edges: parts.map((p) => p.edge),
    });
    expect(g.nodes).toHaveLength(3);
    for (const label of ['Google', 'Meta']) expect(byLabel(g, label), label).toBeDefined();
    expect(g.nodes.filter((n) => /handshake/i.test(n.label))).toHaveLength(1);
  });

  it('calls the company in a current title a current employer', () => {
    const P = 'p';
    const U = 'https://www.linkedin.com/in/x';
    const g = buildGraph({
      nodes: [
        { id: P, type: 'Person', label: 'You' },
        { id: 'h', type: 'Occupation', label: 'Founder at Acme', source: 'search', url: U },
      ],
      edges: [{ src: P, dst: 'h', predicate: 'hasOccupation', weight: 0.8, url: U }],
    });
    expect(byLabel(g, 'Acme')!.description).toBe('Current employer');
    expect(byLabel(g, 'Founder')!.description).toBe('Current role at Acme');
  });

  it('pairs the title and employer on one profile only when no label already paired them', () => {
    const P = 'p';
    const U = 'https://www.linkedin.com/in/x';
    const g = buildGraph({
      nodes: [
        { id: P, type: 'Person', label: 'You' },
        { id: 'h', type: 'Occupation', label: 'Founder at Acme', source: 'search', url: U },
        { id: 't', type: 'Occupation', label: 'Senior Software Engineer', source: 'search', url: U },
        { id: 'w', type: 'Organization', label: 'Handshake', source: 'search', url: U },
      ],
      edges: [
        { src: P, dst: 'h', predicate: 'hasOccupation', weight: 0.8, url: U },
        { src: P, dst: 't', predicate: 'hasOccupation', weight: 0.85, url: U },
        { src: P, dst: 'w', predicate: 'worksFor', weight: 0.85, url: U },
      ],
    });
    expect(edgeBetween(g, 'Founder', 'Acme')?.kind).toBe('role-at');
    expect(edgeBetween(g, 'Senior Software Engineer', 'Handshake')?.kind).toBe('holds');
    expect(edgeBetween(g, 'Senior Software Engineer', 'Acme')).toBeUndefined();
    expect(edgeBetween(g, 'Founder', 'Handshake')).toBeUndefined();
  });

  it('drops vague fragments', () => {
    const labels = sample().nodes.map((n) => n.label.toLowerCase());
    for (const frag of ['self-described', 'job involving', 'broad platform', 'bug reports'])
      expect(
        labels.some((l) => l.includes(frag)),
        frag,
      ).toBe(false);
  });

  it('infers typed links between entities', () => {
    const g = sample();
    expect(edgeBetween(g, 'Software Engineer', 'Slash')?.kind).toBe('role-at');
    expect(edgeBetween(g, 'Software Engineer', 'NOCO')?.kind).toBe('role-at');
    expect(edgeBetween(g, 'Senior Software Engineer', 'Handshake')?.kind).toBe('holds');
    expect(edgeBetween(g, 'Senior Software Engineer', 'Software Engineer')?.kind).toBe('related-role');
    expect(edgeBetween(g, 'Senior Software Engineer', 'Python')?.kind).toBe('uses');
    expect(edgeBetween(g, 'Handshake', 'San Francisco, California')?.kind).toBe('based-in');
    expect(edgeBetween(g, 'Azure', 'Docker')?.kind).toBe('listed-with');
    expect(edgeBetween(g, 'University of Pennsylvania', 'Arizona State University')?.kind).toBe(
      'listed-with',
    );
    expect(edgeBetween(g, 'Rock climbing', 'Social energy')?.kind).toBe('evidence');
    expect(edgeBetween(g, 'Speed vs quality', 'Planning')?.kind).toBe('co-insight');
    // Profile skills reach the role from every list, not only the first.
    const uses = g.edges.filter((e) => e.kind === 'uses');
    expect(uses.length).toBeLessThanOrEqual(6);
    for (const skill of ['Azure', 'Python', 'PyTorch'])
      expect(edgeBetween(g, 'Senior Software Engineer', skill)).toBeDefined();
  });

  it('never rates a link above its weaker end', () => {
    const g = sample();
    const conf = new Map(g.nodes.map((n) => [n.id, n.confidence]));
    for (const e of g.edges) {
      expect(e.weight).toBeLessThanOrEqual(Math.min(conf.get(e.source)!, conf.get(e.target)!));
      expect(e.weight).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    expect(sample()).toEqual(sample());
  });

  it('describes roles from their links and traits from their insight', () => {
    const g = sample();
    expect(byLabel(g, 'Software Engineer')!.description).toBe('Role at NOCO and Slash');
    expect(byLabel(g, 'Senior Software Engineer')!.description).toBe('Current role at Handshake');
    expect(byLabel(g, 'Planning')!.description).toMatch(/shipping fast/);
    expect(byLabel(g, 'Python')!.description).toBe('Programming languages');
  });

  it('handles an empty or person-only KG', () => {
    expect(buildGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
    const person = { nodes: [{ id: 'p', type: 'Person', label: 'You' }], edges: [] };
    expect(buildGraph(person).nodes).toEqual([]);
  });

  it('reads snapshots from before provenance was added', () => {
    const old = sampleKg();
    const bare: UiSnapshot['kg'] = {
      nodes: old.nodes.map(({ id, type, label }) => ({ id, type, label })),
      edges: old.edges.map(({ src, dst, predicate, weight }) => ({ src, dst, predicate, weight })),
    };
    const g = buildGraph(bare);
    expect(byLabel(g, 'Planning')).toBeDefined();
    expect(edgeBetween(g, 'Software Engineer', 'Slash')?.kind).toBe('role-at');
  });
});

describe('filterGraph', () => {
  it('shows only links at or above the threshold, and no isolated nodes', () => {
    const g = sample();
    for (const t of [0.3, DEFAULT_THRESHOLD, 0.6, 0.75]) {
      const v = filterGraph(g, { threshold: t });
      const ids = new Set(v.nodes.map((n) => n.id));
      for (const e of v.edges) {
        expect(e.weight).toBeGreaterThanOrEqual(t);
        expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      }
      for (const n of v.nodes) {
        expect(n.confidence).toBeGreaterThanOrEqual(t);
        expect(v.degree.get(n.id)).toBeGreaterThan(0);
      }
    }
  });

  it('has no hub: no node links to most of the others', () => {
    const v = filterGraph(sample(), { threshold: DEFAULT_THRESHOLD });
    expect(v.nodes.length).toBeGreaterThan(30);
    const most = Math.max(...v.degree.values());
    expect(most).toBeLessThanOrEqual(maxDegree(v.nodes.length));
    expect(most / (v.nodes.length - 1)).toBeLessThan(0.25);
  });

  it('caps a hub without orphaning its neighbors', () => {
    const nodes = Array.from({ length: 21 }, (_, i) => ({
      id: `n${String(i).padStart(2, '0')}`,
      label: `N${i}`,
      short: `N${i}`,
      category: 'skill' as const,
      kind: 'Skill' as const,
      confidence: 0.9,
      description: '',
      sources: [],
      evidence: [],
    }));
    const star = nodes.slice(1).map((n, i) => ({
      id: `hub|${n.id}`,
      source: 'n00',
      target: n.id,
      kind: 'uses' as const,
      weight: 0.6 + i * 0.01,
    }));
    const ring = nodes.slice(1).map((n, i) => ({
      id: `${n.id}|ring`,
      source: n.id,
      target: nodes[1 + ((i + 1) % 20)]!.id,
      kind: 'listed-with' as const,
      weight: 0.8,
    }));
    const v = filterGraph({ nodes, edges: [...star, ...ring] }, { threshold: 0.5 });
    expect(v.degree.get('n00')).toBeLessThanOrEqual(maxDegree(21));
    expect(v.nodes).toHaveLength(21);
    // The hub keeps its strongest links.
    const kept = v.edges.filter((e) => e.source === 'n00').map((e) => e.weight);
    expect(Math.min(...kept)).toBeGreaterThan(0.7);
  });

  it('hides categories, and keeps links across the rest', () => {
    const g = sample();
    const v = filterGraph(g, { threshold: DEFAULT_THRESHOLD, hidden: new Set(['trait']) });
    expect(v.nodes.some((n) => n.category === 'trait')).toBe(false);
    const all = filterGraph(g, { threshold: DEFAULT_THRESHOLD });
    const cat = new Map(all.nodes.map((n) => [n.id, n.category]));
    const cross = all.edges.filter((e) => cat.get(e.source) !== cat.get(e.target));
    expect(
      new Set(cross.map((e) => [cat.get(e.source), cat.get(e.target)].sort().join('-'))).size,
    ).toBeGreaterThanOrEqual(4);
  });

  it('names every cluster first when ordering labels', () => {
    const v = filterGraph(sample(), { threshold: DEFAULT_THRESHOLD });
    const present = new Set(v.nodes.map((n) => n.category));
    const firstFew = labelOrder(v).slice(0, present.size);
    expect(new Set(firstFew.map((n) => n.category))).toEqual(present);
  });
});

describe('layoutGraph', () => {
  const input = (width: number, height: number) => {
    const v = filterGraph(sample(), { threshold: DEFAULT_THRESHOLD });
    const labeled = new Set(
      labelOrder(v)
        .slice(0, 12)
        .map((n) => n.id),
    );
    const nodes: LayoutNode[] = v.nodes.map((n) => ({
      id: n.id,
      category: n.category,
      r: 5,
      ...(labeled.has(n.id) ? { label: { w: n.short.length * 6, h: 14 } } : {}),
    }));
    return { nodes, edges: v.edges, width, height, categories: [...new Set(v.nodes.map((n) => n.category))] };
  };

  it('is deterministic', () => {
    expect([...layoutGraph(input(358, 404))]).toEqual([...layoutGraph(input(358, 404))]);
  });

  for (const [w, h] of [
    [358, 404],
    [624, 500],
  ] as const) {
    it(`keeps nodes and reserved labels apart and on the canvas at ${w}px`, () => {
      const inp = input(w, h);
      const pos = layoutGraph({ ...inp, avoid: [{ x: w - 48, y: 0, w: 48, h: 112 }] });
      const boxes = inp.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const half = Math.max(n.r, (n.label?.w ?? 0) / 2);
        return { x: p.x - half, y: p.y - n.r, w: 2 * half, h: 2 * n.r + (n.label ? 2 + n.label.h : 0) };
      });
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(w);
        expect(b.y + b.h).toBeLessThanOrEqual(h);
        expect(boxesOverlap(b, { x: w - 48, y: 0, w: 48, h: 112 })).toBe(false);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(boxes[i]!, boxes[j]!)).toBe(false);
    });
  }

  it('keeps every node clear of the controls, even one that starts in their corner', () => {
    const cats = ['work', 'skill', 'interest', 'trait', 'place'] as const;
    for (let seed = 0; seed < 40; seed++) {
      const nodes: LayoutNode[] = Array.from({ length: 20 + (seed % 40) }, (_, i) => ({
        id: `s${seed}n${i}`,
        category: cats[(i * 7 + seed) % 5]!,
        r: 3 + ((i + seed) % 6),
        ...(i % 3 === 0 ? { label: { w: 40 + ((i * 13) % 90), h: 14 } } : {}),
      }));
      // Links to a few early nodes, so the layout crowds and some nodes start in the controls' corner.
      const edges = nodes
        .slice(1)
        .map((n, i) => ({ source: nodes[(i * 5 + seed) % i || 0]!.id, target: n.id, weight: 0.6 }));
      for (const [w, h] of [
        [358, 404],
        [420, 428],
        [624, 500],
      ] as const) {
        const avoid = { x: w - 48, y: 0, w: 48, h: 112 };
        const pos = layoutGraph({ nodes, edges, width: w, height: h, categories: [...cats], avoid: [avoid] });
        for (const n of nodes) {
          const p = pos.get(n.id)!;
          const half = Math.max(n.r, (n.label?.w ?? 0) / 2);
          const box = {
            x: p.x - half,
            y: p.y - n.r,
            w: 2 * half,
            h: 2 * n.r + (n.label ? 2 + n.label.h : 0),
          };
          expect(boxesOverlap(box, avoid), `${n.id} at ${w}px`).toBe(false);
        }
      }
    }
  });

  it('clusters by category', () => {
    const inp = input(624, 500);
    const pos = layoutGraph(inp);
    const anchors = anchorsFor(inp.categories, 624, 500);
    for (const c of inp.categories) {
      const pts = inp.nodes.filter((n) => n.category === c).map((n) => pos.get(n.id)!);
      if (pts.length < 3) continue;
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      // Each cluster's center is nearer its own anchor than any other.
      const near = [...anchors].sort(
        ([, a], [, b]) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
      )[0]![0];
      expect(near, c).toBe(c);
    }
  });
});

describe('placeLabels', () => {
  it('never overlaps labels, nodes or areas to avoid, and respects the limit', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n${i}`,
      x: 20 + (i % 8) * 40,
      y: 20 + Math.floor(i / 8) * 30,
      r: 4,
    }));
    const cands = nodes.map((n) => ({ ...n, text: `Label ${n.id}`, w: 60, h: 14 }));
    const avoid = [{ x: 300, y: 0, w: 60, h: 60 }];
    const placed = placeLabels(cands, nodes, { width: 360, height: 200 }, 25, avoid);
    expect(placed.length).toBeGreaterThan(5);
    expect(placed.length).toBeLessThanOrEqual(25);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++)
        expect(boxesOverlap(placed[i]!.box, placed[j]!.box)).toBe(false);
      expect(boxesOverlap(placed[i]!.box, avoid[0]!)).toBe(false);
      const b = placed[i]!.box;
      expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= 360 && b.y + b.h <= 200).toBe(true);
    }
    expect(placeLabels(cands, nodes, { width: 360, height: 200 }, 3)).toHaveLength(3);
  });
});
