import { describe, expect, it } from 'vitest';
import {
  COMPONENT_IDS,
  COMPONENT_SPECS,
  componentProblems,
  componentReadBy,
  fill,
  INCUMBENT_COMPONENTS,
  PREDICT_PROMPTS,
  resolvePredictPrompt,
} from '../src/components';
import { configHash, DEFAULT_CONFIG, PipelineConfig, parsePredictorId } from '../src/config';
import { Gateway } from '../src/gateway';
import { predictionQuestion } from '../src/jev';
import { assertPredictorId, LlmPredictor, makePredictor, promptVersionOf } from '../src/predictors';
import { PROMPTS } from '../src/prompts';
import { renderStateText } from '../src/state-builder';
import type { ChatRequest, PersonState, Question } from '../src/types';

const q = (type: Question['type']): Question => ({
  id: 'q1',
  mimicId: 'm',
  seq: 3,
  kind: 'adaptive',
  type,
  domain: 'casual',
  prompt: 'Pick one',
  options:
    type === 'noul'
      ? [
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ]
      : [
          { key: 'a', label: 'Tea' },
          { key: 'b', label: 'Coffee' },
        ],
  facetIds: [],
  provenance: { generator: 'x', configHash: 'h', promptVersion: 'p' },
});

const state: PersonState = {
  identity: { name: 'P', location: 'L', facts: ['hasSkill: Go'] },
  traits: [{ facet: 'risk_tolerance', mean: 0.5, confidence: 0.4 }],
  insights: [{ text: 'Likes tea', evidence: [1] }],
  evidence: [
    { seq: 1, q: 'Tea or coffee?', type: 'choice', options: ['Tea', 'Coffee'], answer: 'Tea', why: 'calm' },
    { seq: 2, q: 'Early bird?', type: 'noul', options: ['Yes', 'No'], answer: 'No' },
  ],
  meta: { evidenceSeqMax: 2, stateHash: 'h', builder: 'full.v1', tokens: 1 },
};

describe('prediction prompt components (ADR-0028)', () => {
  it('the incumbent renders exactly what the original literals produced', () => {
    // The pre-refactor templates (PLAN §9.6 and the old renderStateText), written out literally.
    expect(predictionQuestion(q('choice'))).toEqual({
      type: 'choice',
      instructions:
        'Predict how the person described in the state would answer this question, based only on the state: "Pick one"',
      criteria: { a: 'The person would choose: Tea', b: 'The person would choose: Coffee' },
    });
    expect(predictionQuestion(q('noul')).criteria).toEqual({
      true: 'The person would answer yes',
      false: 'The person would answer no',
    });
    expect(renderStateText(state)).toBe(
      [
        'IDENTITY',
        'name: P',
        'location: L',
        '- hasSkill: Go',
        '',
        'TRAITS (mean 0–1, confidence 0–1)',
        'risk_tolerance: 0.5 (conf 0.4)',
        '',
        'INSIGHTS',
        '- Likes tea [answers 1]',
        '',
        'ANSWERS',
        '#1 Tea or coffee? [Tea | Coffee] → Tea (why: calm)',
        '#2 Early bird? [Yes | No] → No',
      ].join('\n'),
    );
    expect(INCUMBENT_COMPONENTS['predict.system']).toBe(PROMPTS['predict.v1'].system);
    // Latency hints (ADR-0027) render exactly as the pre-component literal did.
    const paced = {
      ...state,
      evidence: [
        { ...state.evidence[0]!, pace: 'quick' as const },
        { ...state.evidence[1]!, pace: 'slow' as const },
      ],
    };
    expect(renderStateText(paced).split('\n').slice(-2)).toEqual([
      '#1 Tea or coffee? [Tea | Coffee] → Tea (answered quickly) (why: calm)',
      '#2 Early bird? [Yes | No] → No (took a while)',
    ]);
  });

  it('sends the incumbent LLM messages unchanged', async () => {
    const seen: ChatRequest[] = [];
    const gateway = new Gateway({
      decisions: { provider: 'x', decide: async () => Promise.reject(new Error('unused')) },
      llm: {
        provider: 'x',
        chat: async (req) => {
          seen.push(req);
          return {
            content: '{"probs":[{"key":"a","p":0.7},{"key":"b","p":0.3}]}',
            modelSnapshot: 'm',
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
            latencyMs: 1,
            raw: {},
          };
        },
      },
      log: { write: async () => {} },
      clock: () => 0,
      newId: () => 'id',
    });
    const p = new LlmPredictor(gateway, 'vendor/model', { purpose: 't' });
    const [r] = await p.predict(state, [q('choice')]);
    expect(r!.ok).toBe(true);
    expect(p.id).toBe('llm:vendor/model');
    expect(seen[0]!.messages[1]!.content).toBe(
      `STATE:\n${renderStateText(state)}\n\nQUESTION: Pick one\nOPTIONS:\na: Tea\nb: Coffee`,
    );
    expect(seen[0]!.reasoningEffort).toBe('low');
    expect(seen[0]!.maxTokens).toBe(3000);
  });

  it('parses prompt versions in predictor IDs', () => {
    expect(parsePredictorId('llm:vendor/model')).toEqual({ kind: 'llm', model: 'vendor/model' });
    expect(parsePredictorId('jev:typesafe/jev-1.13@jev-predict.v1')).toEqual({
      kind: 'jev',
      model: 'typesafe/jev-1.13',
      promptVersion: 'jev-predict.v1',
    });
    expect(() => parsePredictorId('llm:vendor/model@bad version')).toThrow();
    expect(promptVersionOf('llm:vendor/model')).toBe('predict.v1');
    expect(promptVersionOf('jev:typesafe/jev-1.13')).toBe('jev-predict.v1');
    expect(promptVersionOf('llm:vendor/model@predict.v1')).toBe('predict.v1');
    expect(() => assertPredictorId('llm:vendor/model@nope.v9')).toThrow(/unknown prediction prompt version/);
    expect(() => assertPredictorId('llm:vendor/model@jev-predict.v1')).toThrow(/is a jev prompt, not llm/);
    expect(() => assertPredictorId('llm:vendor/model@predict.v1')).toThrow(/names the incumbent/);
    expect(() => assertPredictorId('jev:typesafe/jev-1.13')).not.toThrow();
    const gw = {} as Gateway;
    expect(makePredictor(gw, 'llm:vendor/model@predict.v1', { purpose: 't' }).id).toBe('llm:vendor/model');
  });

  it('rejects a config naming an unregistered or incumbent prompt version, and reads what Jev reads', () => {
    const cfg = (primary: string, shadows: string[] = []) => ({
      ...DEFAULT_CONFIG,
      predictor: { primary, shadows },
    });
    expect(PipelineConfig.safeParse(cfg('jev:typesafe/jev-1.13')).success).toBe(true);
    expect(PipelineConfig.safeParse(cfg('jev:typesafe/jev-1.13@jev-predict.v9')).success).toBe(false);
    expect(PipelineConfig.safeParse(cfg('jev:typesafe/jev-1.13', ['llm:x/y@predict.v1'])).success).toBe(
      false,
    );
    // The defaults' hashes are pinned elsewhere; validation must not change what parse returns.
    expect(configHash(DEFAULT_CONFIG)).toBe(configHash(PipelineConfig.parse(DEFAULT_CONFIG)));
    const jev = resolvePredictPrompt('jev-predict.v1', 'jev');
    expect(componentReadBy('state.evidence.line', jev)).toBe(false);
    expect(
      componentReadBy('state.evidence.line', { ...jev, harness: { ...jev.harness, jevState: 'text' } }),
    ).toBe(true);
    expect(componentReadBy('predict.system', jev)).toBe(false);
  });

  it('every registered variant resolves, and its components are valid', () => {
    for (const v of Object.values(PREDICT_PROMPTS)) {
      const p = resolvePredictPrompt(v.id, v.kind);
      for (const id of COMPONENT_IDS)
        expect(componentProblems(id, p.components[id]), `${v.id} ${id}`).toEqual([]);
    }
  });

  it('flags missing and unknown placeholders and over-long text', () => {
    expect(componentProblems('predict.user', 'STATE {state} QUESTION {prompt}')).toEqual([
      'missing {options}',
    ]);
    expect(componentProblems('jev.choice', 'Pick {label} {name}')).toEqual(['unknown placeholder {name}']);
    expect(componentProblems('jev.noul.true', 'word '.repeat(41))[0]).toMatch(/41 words/);
    expect(fill('a {x} {y} { "json": 1 }', { x: '1' })).toBe('a 1 {y} { "json": 1 }');
    for (const id of COMPONENT_IDS) expect(COMPONENT_SPECS[id].kinds.length).toBeGreaterThan(0);
  });
});
