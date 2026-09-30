import { describe, expect, it } from 'vitest';
import {
  buildPersona,
  EMPTY_CURATION,
  Gateway,
  type LlmClient,
  ONTOLOGY_V1,
  PersonaCuration,
  type PersonaDraft,
  type PersonaInput,
  type PersonaSource,
  personaKey,
  personaWriterInput,
  pruneCuration,
  stripInlineCites,
  writePersonaDraft,
} from '../src';

const facets = ONTOLOGY_V1.filter((f) => ['openness', 'risk_tolerance', 'extraversion'].includes(f.id));

function src(over: Partial<PersonaSource> = {}): PersonaSource {
  const q = (seq: number, kind: PersonaSource['evidence'][number]['kind'], why: string | null = null) => ({
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
    asOf: Date.UTC(2026, 8, 30),
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
    removedFacts: [],
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
    fidelity: { fidelity: 0.7, ci: [0.6, 0.8], acc: 0.61, accBaseline: 0.49, selfConsistency: 0.8, n: 28 },
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
    { section: 'biases', text: 'Anchors on the first option.', evidenceSeqs: [5], confidence: 0.9 },
    { section: 'values', text: 'Keeps promises to Acme clients.', evidenceSeqs: [1, 2], confidence: 0.8 },
  ],
};
const meta = { id: 'd1', createdAt: 1, seqUpTo: 5, modelSnapshot: 'deepseek@x', promptVersion: 'persona.v1' };

const build = (over: Partial<PersonaInput> = {}) =>
  buildPersona({ source: src(), facets, draft: { ...meta, draft }, curation: EMPTY_CURATION, ...over });

function fakeGateway(content: unknown) {
  const rows: Array<{ purpose: string }> = [];
  const sent: string[] = [];
  const llm: LlmClient = {
    provider: 'fake-llm',
    async chat(req) {
      sent.push(req.messages.map((m) => m.content).join('\n'));
      return {
        content: JSON.stringify(content),
        modelSnapshot: 'm@p',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        latencyMs: 1,
        raw: {},
      };
    },
  };
  let n = 0;
  const g = new Gateway({
    decisions: { provider: 'x', decide: () => Promise.reject(new Error('unused')) },
    llm,
    log: { write: async (r) => void rows.push(r) },
    clock: () => 1,
    newId: () => `id${++n}`,
  });
  return { g, rows, sent };
}

describe('Persona.md (ADR-0033)', () => {
  it('renders the deterministic sections without a draft', () => {
    const v = build({ draft: null });
    const md = v.markdown;
    expect(md.startsWith('# Persona: Avery Quinn\n')).toBe(true);
    expect(md).toContain('built by Mimic from 6 answers they gave about themselves, as of 2026-09-30.');
    expect(md).not.toContain('## Summary');
    expect(md).toContain('- Product designer');
    expect(md).toContain('- Works at: Acme (web search, https://acme.test/team)');
    expect(md).toContain('- Interest: Sailing (inferred from their answers)');
    // The decision model's read wins over psychometric scoring; certainty uses the model panel's tiers.
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
    expect(v.source.answers).toBe(6);
  });

  it('includes a draft, cites only answers in the file, and counts answers since the draft', () => {
    const v = build();
    expect(v.markdown).toContain('## Summary\n\nThey move fast and revisit later.');
    expect(v.markdown).toContain(
      '## How they decide\n\n- Decides fast when a choice is easy to undo. [#2, #3]',
    );
    // One citation means tentative, whatever confidence the writer reported.
    expect(v.markdown).toContain('- Anchors on the first option. _(tentative)_ [#5]');
    expect(v.draft).toMatchObject({ id: 'd1', answers: 5, newAnswers: 1 });

    const hidden = build({ curation: PersonaCuration.parse({ hidden: [personaKey.record(3)] }) });
    expect(hidden.markdown).toContain('easy to undo. [#2]');
    const noRecord = build({ curation: PersonaCuration.parse({ disabled: ['record'] }) });
    expect(noRecord.markdown).not.toMatch(/\[#\d/);
    expect(noRecord.markdown).not.toContain('Citations like');
  });

  it('leaves out draft text that mentions a fact the person removed', () => {
    const v = build({
      source: src({
        facts: src().facts.filter((f) => f.object !== 'Acme'),
        removedFacts: [{ predicate: 'worksAt', object: 'Acme' }],
      }),
    });
    expect(v.markdown).not.toContain('Acme');
    expect(v.markdown).toContain('Decides fast when a choice is easy to undo.');
  });

  it('applies curation: name, own words, edits, hidden items and sections', () => {
    const st = draft.statements[0]!;
    const curation = PersonaCuration.parse({
      name: 'Ave',
      notes: '# My rules\nNever sign on the first call.',
      disabled: ['tendencies', 'unknowns'],
      hidden: [personaKey.identity('location'), personaKey.fact({ predicate: 'worksAt', object: 'Acme' })],
      edits: { [personaKey.statement(st)]: 'Decides within a day\nunless it is hard to undo.' },
    });
    const md = build({ curation }).markdown;
    expect(md.startsWith('# Persona: Ave\n')).toBe(true);
    expect(md).toContain("- Ave's own words come first. They override anything inferred.");
    expect(md).toContain('## In their own words\n\n### My rules\nNever sign on the first call.');
    expect(md).toContain('- Decides within a day unless it is hard to undo. [#2, #3]');
    expect(md).not.toContain('Lisbon');
    expect(md).not.toContain('Works at: Acme');
    expect(md).toContain('Interest: Sailing');
    expect(md).not.toContain('## Measured tendencies');
    expect(md).not.toContain('## Not known yet');
  });

  it('prunes only draft keys a rewrite replaced; hiding a fact, facet or answer survives', () => {
    const st = personaKey.statement(draft.statements[0]!);
    const oldSummary = personaKey.summary('An older summary.');
    const c = pruneCuration(
      PersonaCuration.parse({
        hidden: [
          personaKey.record(2),
          personaKey.trait('patience'),
          'st:gone',
          oldSummary,
          personaKey.record(2),
        ],
        edits: { [st]: 'kept', [oldSummary]: 'stale', [personaKey.record(2)]: 'not editable' },
      }),
      draft,
    );
    expect(c.hidden).toEqual([personaKey.record(2), personaKey.trait('patience')]);
    expect(c.edits).toEqual({ [st]: 'kept' });
    // An edit to an old summary never masks a new one.
    const md = build({ curation: PersonaCuration.parse({ edits: { [oldSummary]: 'Stale.' } }) }).markdown;
    expect(md).toContain('They move fast and revisit later.');
  });

  it('calls itself a strong prior only with enough evidence that beats a measured baseline', () => {
    const md = (fidelity: PersonaSource['fidelity']) =>
      build({ source: src({ fidelity }), draft: null }).markdown;
    const f = { fidelity: 0.5, ci: [0.4, 0.6] as [number, number], selfConsistency: 0.8 };
    expect(md({ ...f, acc: 0.39, accBaseline: 0.5, n: 30 })).toContain('rough sketch');
    expect(md({ ...f, acc: 0.7, accBaseline: 0.5, n: 8 })).toContain('rough sketch');
    expect(md({ ...f, acc: 0.7, accBaseline: null, n: 30 })).toContain('rough sketch');
    expect(md({ ...f, acc: 0.7, accBaseline: 0.5, n: 30 })).toContain('strong prior');
    expect(md(null)).not.toContain('How far to trust it');
    expect(md(null)).toContain('- Everything here is inferred');
  });

  it('strips inline citations, and only citations', () => {
    expect(stripInlineCites('Ships at 80% and improves later (#1, #2).')).toBe(
      'Ships at 80% and improves later.',
    );
    expect(stripInlineCites('Takes the sure thing [#5] when others depend on them (answers 3 and 4)')).toBe(
      'Takes the sure thing when others depend on them',
    );
    expect(stripInlineCites('Weighs costs (#3–#5) and (seq 3, 4) first')).toBe('Weighs costs and first');
    for (const keep of [
      'Moved to a new city (2019) for work.',
      'Picks option (2) when rushed',
      'Splits bills (50, 50)',
      'Rates it 4 [5]',
      'Saves 10% (about $5) each month',
    ])
      expect(stripInlineCites(keep)).toBe(keep);
  });

  it('keeps the name, headlines and repeats away from the writer', () => {
    const { text, shown } = personaWriterInput(
      src({
        facts: [
          ...src().facts,
          {
            predicate: 'headline',
            object: 'Avery Quinn - Designer | LinkedIn',
            source: 'search',
            url: null,
            confidence: 1,
          },
          { predicate: 'created', object: "Quinn's field notes", source: 'search', url: null, confidence: 1 },
        ],
      }),
      facets,
    );
    expect(text).not.toMatch(/Avery|Quinn/);
    expect(text).not.toContain('LinkedIn');
    expect(text).toContain("created: [name]'s field notes");
    expect(text).toContain('occupation: Product designer');
    expect(text).toContain(
      '#2 Question 2? [Act now | Wait | see] → Wait | see (why: Speed matters more to me)',
    );
    expect(text).not.toContain('#4 ');
    expect([...shown]).toEqual([1, 2, 3, 5, 6]);
  });

  it('keeps well-formed statements, cites only answers it showed, and caps each section', async () => {
    const statements = [
      { section: 'values', text: null, evidenceSeqs: [1], confidence: 0.9 },
      { section: 'values', text: 'Uncited.', evidenceSeqs: [], confidence: 0.9 },
      { section: 'values', text: 'Cites a repeat it never saw.', evidenceSeqs: [4], confidence: 0.9 },
      { section: 'values', text: 'Cites a missing answer.', evidenceSeqs: [42], confidence: 0.9 },
      { section: 'nonsense', text: 'Unknown section.', evidenceSeqs: [1], confidence: 0.9 },
      { section: 'beliefs', text: 'Seqs as strings.', evidenceSeqs: ['3', '5'], confidence: '0.8' },
      ...Array.from({ length: 8 }, (_, i) => ({
        section: 'principles',
        text: `When ${i}, they act (#1, #2).`,
        evidenceSeqs: [1, 1, 42, 2],
        confidence: 2,
      })),
    ];
    const { g, rows, sent } = fakeGateway({ summary: 'S (#1).', statements });
    const out = await writePersonaDraft(
      g,
      { purpose: 'persona.draft', mimicId: 'm1' },
      {
        model: 'deepseek/deepseek-v4.1-flash',
        source: src(),
        facets,
      },
    );
    expect(rows.map((r) => r.purpose)).toEqual(['persona.draft']);
    expect(sent[0]).not.toContain('Avery');
    expect(out.draft.summary).toBe('S.');
    expect(out.draft.statements.map((s) => s.section)).toEqual(['beliefs', ...Array(6).fill('principles')]);
    expect(out.draft.statements[0]).toMatchObject({ evidenceSeqs: [3, 5], confidence: 0.8 });
    expect(out.draft.statements[1]).toMatchObject({
      text: 'When 0, they act.',
      evidenceSeqs: [1, 2],
      confidence: 0.5,
    });
    expect(out.dropped).toBe(7);
  });
});
