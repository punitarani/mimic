import { describe, expect, it } from 'vitest';
import { type FactRecord, KG_MAX_NODES, type KgEdgeRecord, type KgNodeRecord, uiKg } from '../src';

const M = 'm1';
const person: KgNodeRecord = {
  id: `${M}:person`,
  mimicId: M,
  type: 'Person',
  label: 'You',
  props: {},
  source: 'intake',
  createdAt: 0,
};
const node = (
  id: string,
  type: KgNodeRecord['type'],
  label: string,
  props: Record<string, unknown> = {},
  source = 'search',
): KgNodeRecord => ({
  id,
  mimicId: M,
  type,
  label,
  props,
  source,
  createdAt: 1,
});
const edge = (
  dst: string,
  predicate: string,
  weight: number,
  sourceRef: string | null,
  source = 'search',
): KgEdgeRecord => ({
  id: `e:${dst}:${sourceRef}`,
  mimicId: M,
  src: person.id,
  dst,
  predicate,
  weight,
  source,
  sourceRef,
  createdAt: 1,
});
const fact = (id: string, over: Partial<FactRecord> = {}): FactRecord => ({
  id,
  mimicId: M,
  predicate: 'hasSkill',
  object: 'x',
  source: 'search',
  sourceRef: null,
  sourceUrl: null,
  confidence: 0.8,
  userState: 'active',
  createdAt: 1,
  userStateAt: null,
  ...over,
});

describe('uiKg', () => {
  it('carries provenance, and drops what the person removed, the scope hides or the reflector superseded', () => {
    const kg = {
      nodes: [
        person,
        node('org', 'Organization', 'Handshake', { url: 'https://www.linkedin.com/in/x' }),
        node('gone', 'Interest', 'crypto trading', {}, 'reflection'),
        node('climb', 'Interest', 'rock climbing', {}, 'reflection'),
        node('facet', 'Facet', 'planning', { facetId: 'planning' }, 'reflection'),
        node('old', 'Facet', 'conformity', { facetId: 'conformity' }, 'reflection'),
        node('hidden', 'Interest', 'church choir', {}, 'reflection'),
        node('blocked', 'Facet', 'religiosity', { facetId: 'religiosity' }, 'reflection'),
      ],
      edges: [
        edge('org', 'worksFor', 0.85, 'f1'),
        edge('gone', 'interestedIn', 0.6, 'f2', 'reflection'),
        edge('climb', 'interestedIn', 0.6, 'f3', 'reflection'),
        edge('facet', 'exhibits', 0.7, 'i1', 'reflection'),
        edge('old', 'exhibits', 0.9, 'i-superseded', 'reflection'),
        // Its fact cites an answer the scope hides, so it isn't among the facts in scope.
        edge('hidden', 'interestedIn', 0.6, 'f-out-of-scope', 'reflection'),
        edge('blocked', 'exhibits', 0.8, 'i2', 'reflection'),
      ],
    };
    const facts = [
      fact('f1', { sourceUrl: 'https://www.linkedin.com/in/x' }),
      fact('f2', { source: 'reflection', sourceRef: 'answers:5', userState: 'removed' }),
      fact('f3', { source: 'reflection', sourceRef: 'answers:13,20' }),
    ];
    const out = uiKg(
      kg,
      facts,
      [
        { id: 'i1', text: 'Plans trips to the hour', evidenceSeqs: [5, 16] },
        { id: 'i2', text: 'Goes to services weekly', evidenceSeqs: [30] },
      ],
      new Set(['religiosity']),
    );
    expect(out.nodes.map((n) => n.id)).toEqual([person.id, 'org', 'climb', 'facet']);
    expect(out.nodes.find((n) => n.id === 'org')).toMatchObject({
      source: 'search',
      url: 'https://www.linkedin.com/in/x',
    });
    expect(out.nodes.find((n) => n.id === 'facet')).toMatchObject({ facetId: 'planning' });
    expect(out.edges.find((e) => e.dst === 'org')).toMatchObject({
      url: 'https://www.linkedin.com/in/x',
      weight: 0.85,
    });
    expect(out.edges.find((e) => e.dst === 'climb')).toMatchObject({ evidence: [13, 20] });
    expect(out.edges.find((e) => e.dst === 'facet')).toMatchObject({
      evidence: [5, 16],
      ref: 'i1',
      note: 'Plans trips to the hour',
    });
    expect(out.edges.some((e) => ['gone', 'old', 'hidden'].includes(e.dst))).toBe(false);
    expect(out.nodes.some((n) => n.id === 'blocked')).toBe(false);
  });

  it('keeps the most confident nodes under the cap, in their original order', () => {
    const many = Array.from({ length: KG_MAX_NODES + 10 }, (_, i) => node(`n${i}`, 'Skill', `skill ${i}`));
    const edges = many.map((n, i) => edge(n.id, 'knowsAbout', i < 10 ? 0.4 : 0.8, `f${i}`));
    const facts = many.map((_, i) => fact(`f${i}`));
    const out = uiKg({ nodes: [person, ...many], edges }, facts, []);
    expect(out.nodes).toHaveLength(KG_MAX_NODES);
    expect(out.nodes[0]!.type).toBe('Person');
    // The ten weakest are the ones left out.
    expect(out.nodes.some((n) => ['n0', 'n9'].includes(n.id))).toBe(false);
    expect(out.nodes[1]!.id).toBe('n10');
    expect(out.edges.every((e) => out.nodes.some((n) => n.id === e.dst))).toBe(true);
  });
});
