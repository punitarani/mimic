import { describe, expect, it } from 'vitest';
import {
  COMPONENT_IDS,
  COMPONENT_SPECS,
  componentProblems,
  componentReadBy,
  fill,
  harnessProblems,
  INCUMBENT_COMPONENTS,
  INCUMBENT_HARNESS,
  PREDICT_PROMPTS,
  promptHash,
  reasoningOf,
  resolvePredictPrompt,
} from '../src/components';
import {
  configHash,
  DEFAULT_CONFIG,
  PipelineConfig,
  parsePredictorId,
  predictorIdProblem,
} from '../src/config';
import { temperatureScale } from '../src/distribution';
import { Gateway } from '../src/gateway';
import { predictionQuestion } from '../src/jev';
import {
  assertPredictorId,
  calibratedResult,
  calibrationTemperatureOf,
  keyedByLabel,
  LlmPredictor,
  makePredictor,
  probsSchema,
  promptVersionOf,
  rawScale,
  selectionView,
} from '../src/predictors';
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

  it('prompt hashes are pinned: they label optimizer candidates and key the eval caches', () => {
    // Taken before ADR-0052 renamed the decision kind; a change here orphans every `cand-<hash>` label and cache entry.
    expect(promptHash(resolvePredictPrompt('jev-predict.v1', 'jev'))).toBe(
      '00e3cc2e765d2f3a0b67140ddc206d41317ed89a2fb36e5705daf9da5fc57d5d',
    );
    expect(promptHash(resolvePredictPrompt('jev-predict.v2', 'jev'))).toBe(
      'abc36f61fbb37cab612b95db85a61b6c89cb982335060cc80892dc9ce1b81db6',
    );
    expect(promptHash(resolvePredictPrompt('predict.v2', 'llm', 'deepseek/deepseek-v4.1-flash'))).toBe(
      'f052d3501e76c38937c5198ba8ae4a6cc05af2d5d4a120839f197cdda57f4079',
    );
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

describe('per-model reasoning budgets and calibration (ADR-0041)', () => {
  const chatGateway = (seen: ChatRequest[], content: string) =>
    new Gateway({
      decisions: {
        provider: 'x',
        decide: async (req) => ({
          modelSnapshot: 'jev-snap',
          answers: Object.fromEntries(
            Object.entries(req.questions).map(([k, dq]) => [
              k,
              dq.type === 'noul'
                ? { type: 'noul' as const, p: 0.95 }
                : {
                    type: 'choice' as const,
                    choice: 'a',
                    confidence: 0.9,
                    probabilities: { a: 0.95, b: 0.05 },
                  },
            ]),
          ),
          usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 },
          latencyMs: 1,
          raw: {},
        }),
      },
      llm: {
        provider: 'x',
        chat: async (req) => {
          seen.push(req);
          return {
            content,
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

  it('resolves predict.v2 per model: an effort where the model takes one, a budget where it only takes a budget', () => {
    const qwen = resolvePredictPrompt('predict.v2', 'llm', 'qwen/qwen3.8-flash').harness;
    expect(qwen.reasoningMaxTokens).toBe(1024);
    expect(qwen.maxTokens).toBeGreaterThan(qwen.reasoningMaxTokens! + 500);
    const glm = resolvePredictPrompt('predict.v2', 'llm', 'z-ai/glm-5.3-flash').harness;
    expect(glm).toMatchObject({ reasoningEffort: 'low', reasoningMaxTokens: null, maxTokens: 3000 });
    // A model the variant doesn't list has no measured settings, so it can't be named with predict.v2 (no silent
    // fallback to the incumbent's effort and cap); the text is the incumbent's for every model.
    expect(predictorIdProblem('llm:acme/other@predict.v2')).toMatch(
      /no measured reasoning settings for acme\/other/,
    );
    expect(predictorIdProblem('llm:qwen/qwen3.8-flash:nitro@predict.v2')).toMatch(
      /no measured reasoning settings/,
    );
    expect(() =>
      PipelineConfig.parse({
        ...DEFAULT_CONFIG,
        predictor: { primary: DEFAULT_CONFIG.predictor.primary, shadows: ['llm:acme/other@predict.v2'] },
      }),
    ).toThrow(/no measured reasoning settings/);
    for (const id of DEFAULT_CONFIG.predictor.shadows) expect(predictorIdProblem(id)).toBeNull();
    expect(resolvePredictPrompt('predict.v2', 'llm', 'acme/other').harness).toEqual({
      ...INCUMBENT_HARNESS,
      keyEnum: true,
      labelKeys: true,
    });
    expect(resolvePredictPrompt('predict.v2', 'llm', 'qwen/qwen3.8-flash').components).toEqual(
      INCUMBENT_COMPONENTS,
    );
    // Every LLM shadow in the default config has measured settings (ADR-0041).
    for (const id of DEFAULT_CONFIG.predictor.shadows) {
      const spec = parsePredictorId(id);
      if (spec.kind === 'llm') expect(PREDICT_PROMPTS['predict.v2']!.modelHarness).toHaveProperty(spec.model);
    }
  });

  it('sends the budget and cap a shadow is configured with, and records predict.v2', async () => {
    const seen: ChatRequest[] = [];
    const gw = chatGateway(seen, '{"probs":[{"key":"a","p":0.7},{"key":"b","p":0.3}]}');
    const p = makePredictor(gw, 'llm:qwen/qwen3.8-flash@predict.v2', { purpose: 't' });
    const [r] = await p.predict(state, [q('choice')]);
    expect(r!.ok).toBe(true);
    expect(seen[0]).toMatchObject({ reasoningMaxTokens: 1024, maxTokens: 2048 });
    expect(promptVersionOf('llm:qwen/qwen3.8-flash@predict.v2')).toBe('predict.v2');
    const v1: ChatRequest[] = [];
    await makePredictor(
      chatGateway(v1, '{"probs":[{"key":"a","p":0.7},{"key":"b","p":0.3}]}'),
      'llm:qwen/qwen3.8-flash',
      {
        purpose: 't',
      },
    ).predict(state, [q('choice')]);
    expect(v1[0]).not.toHaveProperty('reasoningMaxTokens');
    expect(v1[0]!.maxTokens).toBe(3000);
    // One reasoning control per request, so the logged request is what was sent.
    expect(seen[0]).not.toHaveProperty('reasoningEffort');
    expect(v1[0]).toMatchObject({ reasoningEffort: 'low' });
    // predict.v2 pins the answer's keys to the options; the incumbent's schema is untouched (same object).
    const items = (
      seen[0]!.jsonSchema!.schema as { properties: { probs: { items: { properties: { key: unknown } } } } }
    ).properties.probs.items.properties.key;
    expect(items).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(v1[0]!.jsonSchema!.schema).toBe(PROMPTS['predict.v1'].schema);
  });

  it('keeps room for the answer and never sends a zero budget as no budget', () => {
    const h = { ...INCUMBENT_HARNESS, reasoningMaxTokens: 1024, maxTokens: 2048 };
    expect(harnessProblems(h)).toEqual([]);
    expect(harnessProblems({ ...h, maxTokens: 1200 })).toEqual([
      expect.stringMatching(/leaves under 256 tokens/),
    ]);
    expect(harnessProblems({ ...h, reasoningMaxTokens: 0 })[0]).toMatch(/positive integer or null/);
    expect(reasoningOf({ reasoningEffort: 'low', reasoningMaxTokens: 0 })).toEqual({ reasoningMaxTokens: 0 });
    expect(reasoningOf({ reasoningEffort: 'low', reasoningMaxTokens: null })).toEqual({
      reasoningEffort: 'low',
    });
    // Every registered variant, on every model it lists, leaves room for the answer.
    for (const v of Object.values(PREDICT_PROMPTS))
      for (const m of Object.keys(v.modelHarness ?? { any: {} }))
        expect(harnessProblems(resolvePredictPrompt(v.id, v.kind, m).harness)).toEqual([]);
    // The reasoned schema keeps its rationale field when keys are pinned.
    const reasoned = probsSchema({ schema: 'reasoned', keyEnum: true }, ['x', 'y']) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(reasoned.properties)).toEqual(['reasoning', 'probs']);
    expect(reasoned.required).toEqual(['reasoning', 'probs']);
  });

  it('accepts option labels as keys under predict.v2, only when they cover every option unambiguously', async () => {
    const labels = '{"probs":[{"key":"Tea","p":0.8},{"key":" coffee ","p":0.2}]}';
    const [v2] = await makePredictor(chatGateway([], labels), 'llm:qwen/qwen3.8-flash@predict.v2', {
      purpose: 't',
    }).predict(state, [q('choice')]);
    expect(v2).toMatchObject({ ok: true, dist: { a: 0.8, b: 0.2 } });
    // The incumbent keeps failing such output, so stored predict.v1 behaviour doesn't change.
    const [v1] = await makePredictor(chatGateway([], labels), 'llm:qwen/qwen3.8-flash', {
      purpose: 't',
    }).predict(state, [q('choice')]);
    expect(v1).toMatchObject({ ok: false, error: 'output does not cover every option' });
    // Keys win; a partial, mixed-up or ambiguous mapping is left alone.
    const tea = q('choice');
    expect(keyedByLabel({ a: 0.6, b: 0.4 }, tea)).toEqual({ a: 0.6, b: 0.4 });
    expect(keyedByLabel({ Tea: 1 }, tea)).toEqual({ Tea: 1 });
    expect(keyedByLabel({ a: 0.5, Tea: 0.5 }, tea)).toEqual({ a: 0.5, Tea: 0.5 });
    const twins = { ...tea, options: tea.options.map((o) => ({ ...o, label: 'Same' })) };
    expect(keyedByLabel({ Same: 1 }, twins)).toEqual({ Same: 1 });
    // An entry that is neither a key nor a label is ignored, as it is for an answer keyed by keys.
    expect(keyedByLabel({ Tea: 0.7, Coffee: 0.2, Unsure: 0.1 }, tea)).toEqual({ a: 0.7, b: 0.2 });
    // Keys that are also Object.prototype names are matched as own keys only.
    const proto = {
      ...tea,
      options: [
        { key: 'constructor', label: 'Build' },
        { key: 'toString', label: 'Say' },
      ],
    };
    expect(keyedByLabel({ Build: 0.6, Say: 0.4 }, proto)).toEqual({ constructor: 0.6, toString: 0.4 });
  });

  it('calibrates Jev without changing its pick', async () => {
    const gw = chatGateway([], '');
    const [raw] = await makePredictor(gw, 'jev:typesafe/jev-1.13', { purpose: 't' }).predict(state, [
      q('choice'),
    ]);
    const [cal] = await makePredictor(gw, 'jev:typesafe/jev-1.13@jev-predict.v2', { purpose: 't' }).predict(
      state,
      [q('choice')],
    );
    expect(raw!.dist.a).toBeCloseTo(0.95);
    expect(cal!.dist.a).toBeLessThan(0.7);
    expect(cal!.dist.a).toBeGreaterThan(cal!.dist.b!);
    expect(cal!.confidence).toBeCloseTo(cal!.dist.a!);
    expect(raw!.confidence).toBe(0.9);
    // A noul confidence stays on Jev's |p − 0.5|·2 scale after calibration.
    const [rawNoul] = await makePredictor(gw, 'jev:typesafe/jev-1.13', { purpose: 't' }).predict(state, [
      q('noul'),
    ]);
    const [calNoul] = await makePredictor(gw, 'jev:typesafe/jev-1.13@jev-predict.v2', {
      purpose: 't',
    }).predict(state, [q('noul')]);
    expect(rawNoul!.confidence).toBeCloseTo(Math.abs(rawNoul!.dist.yes! - 0.5) * 2);
    expect(calNoul!.confidence).toBeCloseTo(Math.abs(calNoul!.dist.yes! - 0.5) * 2);
    expect(temperatureScale({ a: 0.6, b: 0.4 }, 1)).toEqual({ a: 0.6, b: 0.4 });
  });

  it('selects on the raw scale, calibrates only the stored prediction, and undoes it exactly (ADR-0048)', async () => {
    const gw = chatGateway([], '');
    const ctx = { purpose: 't' };
    const view = selectionView(gw, 'jev:typesafe/jev-1.13@jev-predict.v2');
    const [raw] = await view.predictor(ctx).predict(state, [q('choice')]);
    const [incumbent] = await makePredictor(gw, 'jev:typesafe/jev-1.13', ctx).predict(state, [q('choice')]);
    const [stored] = await makePredictor(gw, 'jev:typesafe/jev-1.13@jev-predict.v2', ctx).predict(state, [
      q('choice'),
    ]);
    // Selection sees the raw scale; one call serves both, since the rescale is exactly what the calibrated predictor
    // stores; and the selection side can read the stored row back on the raw scale.
    expect(raw!.dist).toEqual(incumbent!.dist);
    expect(view.calibrate(raw!, q('choice'))).toEqual(stored);
    const back = rawScale('jev:typesafe/jev-1.13@jev-predict.v2', stored!.dist);
    for (const k of Object.keys(raw!.dist)) expect(back[k]).toBeCloseTo(raw!.dist[k]!, 9);
    expect(calibrationTemperatureOf('jev:typesafe/jev-1.13@jev-predict.v2')).toBe(4);
    expect(calibrationTemperatureOf('llm:deepseek/deepseek-v4.1-flash')).toBe(1);
    expect(calibrationTemperatureOf('not an id')).toBe(1);
    expect(rawScale('jev:typesafe/jev-1.13', raw!.dist)).toBe(raw!.dist);
    // Uncalibrated primaries pass through, and a failure is never rescaled.
    const plain = selectionView(gw, 'jev:typesafe/jev-1.13');
    expect(plain.calibrate(raw!, q('choice'))).toBe(raw);
    const failedResult = { dist: {}, costUsd: 0, latencyMs: 0, modelSnapshot: 'm', ok: false, error: 'x' };
    expect(calibratedResult(failedResult, q('choice'), 4)).toBe(failedResult);
    // An LLM reports no confidence, calibrated or not, so the rescale matches what the LLM predictor itself returns.
    const llmPrompt = resolvePredictPrompt('predict.v1', 'llm');
    const t2 = { ...llmPrompt, harness: { ...llmPrompt.harness, calibrationTemperature: 2 } };
    const [llmRaw] = await new LlmPredictor(gw, 'x/y', ctx, llmPrompt).predict(state, [q('choice')]);
    const [llmCal] = await new LlmPredictor(gw, 'x/y', ctx, t2).predict(state, [q('choice')]);
    expect(llmCal!.confidence).toBeUndefined();
    expect(calibratedResult(llmRaw!, q('choice'), 2)).toEqual({ ...llmCal!, latencyMs: llmRaw!.latencyMs });
  });
});
