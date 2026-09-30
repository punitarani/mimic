import type { UiSnapshot } from '@mimic/core';

/**
 * A snapshot KG shaped like a real one after a profile search and ~20 answers, for the builder's tests: composite
 * labels, a duplicate place, list-valued skills, vague reflection fragments, and insights over 26 facets.
 */

type Kg = UiSnapshot['kg'];
type Facet = UiSnapshot['facets'][number];

const PREDICATE_NODE: Record<string, { type: string; edge: string }> = {
  worksAt: { type: 'Organization', edge: 'worksFor' },
  workedAt: { type: 'Organization', edge: 'workedFor' },
  educatedAt: { type: 'Organization', edge: 'alumniOf' },
  livesIn: { type: 'Place', edge: 'homeLocation' },
  hasSkill: { type: 'Skill', edge: 'knowsAbout' },
  hasInterest: { type: 'Interest', edge: 'interestedIn' },
  jobTitle: { type: 'Occupation', edge: 'hasOccupation' },
};

const PROFILE = 'https://www.linkedin.com/in/sample-person';

/** [predicate, object, confidence, answer seqs (reflection facts) or a source URL]. */
export const SAMPLE_FACTS: Array<[string, string, number, number[] | string]> = [
  ['jobTitle', 'Senior Software Engineer', 0.85, PROFILE],
  ['worksAt', 'Handshake (Handshake AI)', 0.85, PROFILE],
  ['workedAt', 'Slash — Software Engineer', 0.65, PROFILE],
  ['workedAt', 'NOCO — Software Engineer (2019–2021)', 0.65, PROFILE],
  ['workedAt', 'Prospify — Co-Founder, Backend Lead', 0.65, PROFILE],
  ['educatedAt', 'University of Pennsylvania', 0.85, PROFILE],
  ['educatedAt', 'Arizona State University', 0.85, PROFILE],
  ['livesIn', 'San Francisco, California', 0.7, PROFILE],
  ['livesIn', 'San Francisco, California.', 0.65, PROFILE],
  ['hasSkill', 'Technologies: Azure, Docker, Kubernetes, PostgreSQL', 0.65, PROFILE],
  ['hasSkill', 'Programming languages: Python, TypeScript, Go', 0.65, PROFILE],
  ['hasSkill', 'Frameworks: PyTorch, FastAPI, React', 0.65, PROFILE],
  ['hasSkill', 'uses automated testing', 0.6, [4, 9]],
  ['hasSkill', 'writing code for data pipelines', 0.6, [9, 14]],
  ['hasSkill', 'self-described balanced or flexible planner', 0.6, [6]],
  ['hasSkill', 'system design', 0.6, [8, 14]],
  ['hasInterest', 'comparing expert reviews', 0.6, [11, 17]],
  ['hasInterest', 'writing bug reports with clear repro steps', 0.6, [4]],
  ['hasInterest', 'job involving complex tech', 0.6, [2, 8]],
  ['hasInterest', 'broad platform role over deep specialization', 0.6, [2]],
  ['hasInterest', 'rock climbing', 0.6, [13, 20]],
  ['hasInterest', 'sci-fi novels', 0.6, [13]],
  ['livesIn', 'San Francisco', 0.6, [1]],
  ['worksAt', 'Handshake', 0.6, [2]],
];

/** [facet IDs, answer seqs, confidence, text]. */
export const SAMPLE_INSIGHTS: Array<[string[], number[], number, string]> = [
  [
    ['speed_vs_quality', 'planning'],
    [4, 9, 14],
    0.8,
    'Chose shipping fast over polish in 3 of 4 work scenarios',
  ],
  [['maximizing', 'deliberation'], [11, 17], 0.75, 'Compares options at length before buying'],
  [['autonomy', 'leadership_drive'], [2, 8], 0.7, 'Prefers owning a problem end to end'],
  [['social_energy', 'extraversion'], [13, 20], 0.65, 'Recharges alone after busy weeks'],
  [['conflict_directness', 'directness'], [6, 15], 0.7, 'Raises disagreements with teammates directly'],
  [['risk_tolerance', 'openness_to_change'], [3, 18], 0.6, 'Takes calculated risks on new ventures'],
  [['planning', 'detail_orientation', 'routine'], [5, 16], 0.55, 'Plans trips down to the hour'],
  [['taste_novelty', 'openness'], [12, 13], 0.6, 'Orders the dish they have never tried'],
  [['trust', 'collaboration'], [7, 10], 0.5, "Takes coworkers' estimates at face value"],
  [['patience', 'loss_aversion'], [3, 19], 0.55, 'Waits for a better offer rather than settle'],
  [['verbosity', 'formality'], [15, 21], 0.65, 'Writes short, casual messages'],
  [['self_enhancement'], [2], 0.45, 'Wants recognition for their work'],
  [['emotional_stability', 'conscientiousness'], [9, 22], 0.6, 'Stays steady under deadline pressure'],
  [['conformity', 'agreeableness'], [7, 10], 0.4, "Goes along with the team's tooling choices"],
  [['humor'], [21], 0.5, 'Jokes to ease tense moments'],
  [['spending_style', 'self_transcendence'], [12, 20], 0.45, 'Spends on experiences over things'],
  [['reciprocity'], [7], 0.5, 'Returns favors quickly'],
  [['ambiguity_tolerance'], [3, 8], 0.6, 'Starts without a full spec'],
];

export function sampleKg(): Kg {
  const person = 'm1:person';
  const nodes: Kg['nodes'] = [{ id: person, type: 'Person', label: 'You', source: 'intake' }];
  const edges: Kg['edges'] = [];
  const ids = new Map<string, string>();
  SAMPLE_FACTS.forEach(([predicate, object, weight, from], i) => {
    const map = PREDICATE_NODE[predicate]!;
    const key = `${map.type}|${object.trim().toLowerCase()}`;
    const source = typeof from === 'string' ? 'search' : 'reflection';
    let id = ids.get(key);
    if (!id) {
      id = `m1:n:${i}`;
      ids.set(key, id);
      nodes.push({
        id,
        type: map.type,
        label: object,
        source,
        ...(typeof from === 'string' ? { url: from } : {}),
      });
    }
    edges.push({
      src: person,
      dst: id,
      predicate: map.edge,
      weight,
      source,
      ...(typeof from === 'string' ? { url: from } : { evidence: from }),
    });
  });
  SAMPLE_INSIGHTS.forEach(([facetIds, evidence, weight, note], i) => {
    for (const f of facetIds) {
      const id = `m1:facet:${f}`;
      if (!nodes.some((n) => n.id === id))
        nodes.push({ id, type: 'Facet', label: f, source: 'reflection', facetId: f });
      edges.push({
        src: person,
        dst: id,
        predicate: 'exhibits',
        weight,
        source: 'reflection',
        evidence,
        ref: `ins${i}`,
        note,
      });
    }
  });
  return { nodes, edges };
}

export function sampleFacets(): Facet[] {
  const ids = [...new Set(SAMPLE_INSIGHTS.flatMap(([f]) => f))];
  return ids.map((id, i) => ({
    id,
    group: 'Personality',
    name: id.replace(/_/g, ' '),
    low: 'Low',
    high: 'High',
    labels: ['Strongly low', 'Leans low', 'Balanced', 'Leans high', 'Strongly high'],
    mean: (i % 5) / 4,
    certainty: 0.3 + (i % 6) / 10,
    coverage: 1,
    supporting: SAMPLE_INSIGHTS.filter(([f]) => f.includes(id)).flatMap(([, ev]) => ev),
  }));
}
