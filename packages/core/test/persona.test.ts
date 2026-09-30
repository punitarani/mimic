import { describe, expect, it } from 'vitest';
import {
  buildPersona,
  EMPTY_CURATION,
  Gateway,
  type LlmClient,
  type MimicJson,
  ONTOLOGY_V1,
  PersonaCuration,
  type PersonaDraft,
  personaKey,
  personaWriterInput,
  pruneCuration,
  stripInlineCites,
  writePersonaDraft,
} from '../src';

const facets = ONTOLOGY_V1.filter((f) => ['openness', 'risk_tolerance', 'extraversion'].includes(f.id));

function doc(over: Partial<MimicJson> = {}): MimicJson {
  const q = (seq: number, kind: MimicJson['evidence'][number]['kind'], why: string | null = null) => ({
    seq,
    kind,
    type: 'choice' as const,
    prompt: `Question ${seq}?`,
    options: ['Act now', 'Wait | see'],
    optionKeys: ['a', 'b'],
    answer: 'b',
    why,
  });
  return {
    schema: 'mimic/1',
    mimicId: 'm1',
    version: 3,
    createdAt: Date.UTC(2026, 8, 30),
    seqUpTo: 6,
    subject: { displayName: 'Avery Quinn', location: 'Lisbon, PT', occupation: 'Product designer' },
    facts: [
      {
        predicate: 'worksAt',
        object: 'Acme',
        source: 'search',
        url: 'https://acme.test/team',
        confidence: 0.9,
      },
      { predicate: 'hasInterest', object: 'Sailing', source: 'reflection', url: null, confidence: 0.6 },
    ],
    evidence: [
      q(1, 'anchor'),
      q(2, 'adaptive', 'Speed matters more to me'),
      q(3, 'adaptive'),
      q(4, 'repeat'),
      q(5, 'adaptive'),
      q(6, 'playground'),
    ],
    traits: [
      { facet: 'openness', method: 'jev', mean: 0.8, dist: {}, confidence: 0.7, n: 3 },
      { facet: 'openness', method: 'psychometric', mean: 0.1, dist: {}, confidence: 0.3, n: 1 },
      { facet: 'risk_tolerance', method: 'jev', mean: 0.5, dist: {}, confidence: 0.2, n: 2 },
      { facet: 'extraversion', method: 'jev', mean: 0.2, dist: {}, confidence: 0.9, n: 0 },
    ],
    insights: [
      { text: 'Chose speed over polish in work scenarios.', facets: ['openness'], evidence: [5, 2] },
    ],
    kg: { nodes: [], edges: [] },
    fidelity: { fidelity: 0.7, ci: [0.6, 0.8], acc: 0.61, accBaseline: 0.49, selfConsistency: 0.8, n: 28 },
    pipeline: { configHash: 'h', config: {}, models: { primary: 'typesafe/jev-1.13-x' } },
    ...over,
  };
}

const draft: PersonaDraft = {
  summary: 'They move fast and revisit later.',
  statements: [
    {
      section: 'decision_style',
      text: 'Decides fast when a choice is easy to undo.',
      evidenceSeqs: [2, 3],
      confidence: 0.7,
    },
    { section: 'biases', text: 'Anchors on the first option.', evidenceSeqs: [5], confidence: 0.4 },
  ],
};
const meta = {
  id: 'd1',
  createdAt: 1,
  seqUpTo: 5,
  snapshotVersion: 2,
  modelSnapshot: 'deepseek@x',
  promptVersion: 'persona.v1',
};

describe('Persona.md (ADR-0027)', () => {
  it('renders the deterministic sections without a draft', () => {
    const v = buildPersona({ doc: doc(), facets, draft: null, curation: EMPTY_CURATION });
    const md = v.markdown;
    expect(md.startsWith('# Persona: Avery Quinn\n')).toBe(true);
    expect(md).toContain('built by Mimic from 6 answers');
    expect(md).not.toContain('## Summary');
    expect(md).toContain('- Product designer');
    expect(md).toContain('- Works at: Acme (web search, https://acme.test/team)');
    expect(md).toContain('- Interest: Sailing (inferred from their answers)');
    // The decision model's read wins over psychometric scoring; certainty is spelled out.
    expect(md).toContain(
      '- Openness: leans toward novelty and ideas (Prefers the familiar ↔ Seeks novelty and ideas; high certainty)',
    );
    // Low certainty, or no direct evidence, is listed as unknown instead of as a tendency.
    expect(md).toContain(
      "## Not known yet\n\nThere isn't enough evidence yet on: extraversion, risk tolerance.",
    );
    expect(md).not.toContain('- Extraversion:');
    expect(md).toContain(
      "predicted 61% of Avery's answers before seeing them (49% from context alone), over 28 questions",
    );
    // Repeats stay out of the record; reasons are quoted; option labels are kept whole.
    expect(md).not.toContain('**#4**');
    expect(md).toContain(
      '- **#2** Question 2? _(Act now · Wait | see)_ → **Wait | see**. Why: “Speed matters more to me”',
    );
    expect(md).toContain('- Chose speed over polish in work scenarios. [#2, #5]');
    expect(v.draft).toBeNull();
  });

  it('includes a draft, cites only answers in the file, and reports new answers since the draft', () => {
    const v = buildPersona({ doc: doc(), facets, draft: { ...meta, draft }, curation: EMPTY_CURATION });
    expect(v.markdown).toContain('## Summary\n\nThey move fast and revisit later.');
    expect(v.markdown).toContain(
      '## How they decide\n\n- Decides fast when a choice is easy to undo. [#2, #3]',
    );
    expect(v.markdown).toContain('- Anchors on the first option. _(tentative)_ [#5]');
    expect(v.draft).toMatchObject({ id: 'd1', newAnswers: 1 });

    const hidden = buildPersona({
      doc: doc(),
      facets,
      draft: { ...meta, draft },
      curation: PersonaCuration.parse({ hidden: [personaKey.record(3)] }),
    });
    expect(hidden.markdown).toContain('easy to undo. [#2]');
    const noRecord = buildPersona({
      doc: doc(),
      facets,
      draft: { ...meta, draft },
      curation: PersonaCuration.parse({ disabled: ['record'] }),
    });
    expect(noRecord.markdown).not.toMatch(/\[#\d/);
    expect(noRecord.markdown).not.toContain('Citations like');
  });

  it('applies curation: name, own words, edits, hidden items and sections', () => {
    const st = draft.statements[0]!;
    const curation = PersonaCuration.parse({
      name: 'Ave',
      notes: '# My rules\nNever sign on the first call.',
      disabled: ['tendencies', 'unknowns'],
      hidden: [
        personaKey.identity('location'),
        personaKey.fact(draft && { predicate: 'worksAt', object: 'Acme' }),
      ],
      edits: { [personaKey.statement(st)]: 'Decides within a day\nunless it is hard to undo.' },
    });
    const md = buildPersona({ doc: doc(), facets, draft: { ...meta, draft }, curation }).markdown;
    expect(md.startsWith('# Persona: Ave\n')).toBe(true);
    expect(md).toContain("- Ave's own words come first. They override anything inferred.");
    expect(md).toContain('## In their own words\n\n### My rules\nNever sign on the first call.');
    expect(md).toContain('- Decides within a day unless it is hard to undo. [#2, #3]');
    expect(md).not.toContain('Lisbon');
    expect(md).not.toContain('Acme');
    expect(md).toContain('Interest: Sailing');
    expect(md).not.toContain('## Measured tendencies');
    expect(md).not.toContain('## Not known yet');
  });

  it('prunes curation keys that match no item', () => {
    const v = buildPersona({ doc: doc(), facets, draft: { ...meta, draft }, curation: EMPTY_CURATION });
    const st = personaKey.statement(draft.statements[0]!);
    const c = pruneCuration(
      PersonaCuration.parse({
        hidden: [personaKey.record(2), 'ex:999', personaKey.record(2)],
        edits: { [st]: 'kept', [personaKey.record(2)]: 'not editable', 'st:gone': 'stale' },
      }),
      v.sections,
    );
    expect(c.hidden).toEqual([personaKey.record(2)]);
    expect(c.edits).toEqual({ [st]: 'kept' });
  });

  it('calls itself a strong prior only with enough evidence that beats the baseline', () => {
    const md = (fidelity: MimicJson['fidelity']) =>
      buildPersona({ doc: doc({ fidelity }), facets, draft: null, curation: EMPTY_CURATION }).markdown;
    const f = { fidelity: 0.5, ci: [0.4, 0.6] as [number, number], selfConsistency: 0.8 };
    expect(md({ ...f, acc: 0.39, accBaseline: 0.5, n: 30 })).toContain('rough sketch');
    expect(md({ ...f, acc: 0.7, accBaseline: 0.5, n: 8 })).toContain('rough sketch');
    expect(md({ ...f, acc: 0.7, accBaseline: 0.5, n: 30 })).toContain('strong prior');
    expect(md(null)).not.toContain('How far to trust it');
    expect(md(null)).toContain('- Everything here is inferred');
  });

  it('strips inline citations the writer was told not to write', () => {
    expect(stripInlineCites('Ships at 80% and improves later (#1, #2).')).toBe(
      'Ships at 80% and improves later.',
    );
    expect(stripInlineCites('Takes the sure thing [#5] when others depend on them (answers 3 and 4)')).toBe(
      'Takes the sure thing when others depend on them',
    );
    expect(stripInlineCites('Saves 10% (about $5) each month')).toBe('Saves 10% (about $5) each month');
  });

  it('never sends the name to the writer', () => {
    const input = personaWriterInput(doc(), facets);
    expect(input).not.toContain('Avery');
    expect(input).toContain('occupation: Product designer');
    expect(input).toContain(
      '#2 Question 2? [Act now | Wait | see] → Wait | see (why: Speed matters more to me)',
    );
  });

  it('drops statements without a real citation and caps each section', async () => {
    const statements = [
      { section: 'values', text: 'Uncited.', evidenceSeqs: [], confidence: 0.9 },
      { section: 'values', text: 'Cites a missing answer.', evidenceSeqs: [42], confidence: 0.9 },
      { section: 'nonsense', text: 'Unknown section.', evidenceSeqs: [1], confidence: 0.9 },
      ...Array.from({ length: 8 }, (_, i) => ({
        section: 'principles',
        text: `When ${i}, they act (#1, #2).`,
        evidenceSeqs: [1, 1, 42, 2],
        confidence: 2,
      })),
    ];
    const llm: LlmClient = {
      provider: 'fake-llm',
      async chat() {
        return {
          content: JSON.stringify({ summary: 'S.', statements }),
          modelSnapshot: 'm@p',
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          latencyMs: 1,
          raw: {},
        };
      },
    };
    const rows: string[] = [];
    let n = 0;
    const g = new Gateway({
      decisions: { provider: 'x', decide: () => Promise.reject(new Error('unused')) },
      llm,
      log: { write: async (r) => void rows.push(r.purpose) },
      clock: () => 1,
      newId: () => `id${++n}`,
    });
    const out = await writePersonaDraft(
      g,
      { purpose: 'persona.draft', mimicId: 'm1' },
      {
        model: 'deepseek/deepseek-v4.1-flash',
        doc: doc(),
        facets,
      },
    );
    expect(rows).toEqual(['persona.draft']);
    expect(out.draft.statements).toHaveLength(6);
    expect(out.draft.statements.every((s) => s.section === 'principles')).toBe(true);
    expect(out.draft.statements[0]).toMatchObject({
      text: 'When 0, they act.',
      evidenceSeqs: [1, 2],
      confidence: 0.5,
    });
    expect(out.dropped).toBe(5);
  });
});
