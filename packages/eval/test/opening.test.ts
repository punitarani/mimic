import {
  ANCHORS_E9_V1,
  ANCHORS_E9_V1_KEYS,
  DEFAULT_CONFIG,
  E7_PROBES_CONFIG,
  E7_PROBES_LABEL,
  E9_OPENING_CONFIG,
  E9_OPENING_LABEL,
  EXPERIMENT_PRESETS,
  ONTOLOGY_V2,
  RESERVE_V2,
  registerConfig,
  setupPreset,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript, type TurnLog } from '../src/session';

/**
 * E9's opening as an arm (ADR-0073): the set, the config and preset, and how it is served. Offline fakes: this checks
 * what is asked and when, never how well anything predicts.
 */

const SENSITIVE = new Set(ONTOLOGY_V2.filter((f) => f.sensitive).map((f) => f.id));
const isSensitive = (facetIds: string[]) => facetIds.some((f) => SENSITIVE.has(f));
const MIN_ANSWERED = 6;

let engine: LocalEngine;
let t = Date.now();
let opening: string;
beforeAll(async () => {
  engine = await openLocalEngine({
    db: ':memory:',
    providers: 'offline',
    seed: 'e9-opening',
    clock: () => (t += 1_000),
  });
  opening = await registerConfig(engine.deps, E9_OPENING_CONFIG, E9_OPENING_LABEL);
});
afterAll(() => engine.close());

const script = (name: string, extra: Partial<SessionScript> = {}) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT' },
    consentResearch: true,
    seed: name,
    ...extra,
  });

const anchorsServed = (turns: TurnLog[]) => turns.filter((x) => x.kind === 'anchor').map((x) => x.itemKey);

describe('anchors.e9.v1 and cfg.e9.opening (ADR-0073)', () => {
  it('is reserve.v2 wording, off the shared probes, with its sensitive questions last', () => {
    expect(ANCHORS_E9_V1.map((a) => a.itemKey)).toEqual([...ANCHORS_E9_V1_KEYS]);
    for (const a of ANCHORS_E9_V1) expect(RESERVE_V2).toContain(a);
    const probeFacets = new Set(
      (E7_PROBES_CONFIG.probes?.shared ?? []).flatMap(
        (k) => RESERVE_V2.find((r) => r.itemKey === k)!.facetIds,
      ),
    );
    expect(probeFacets.size).toBeGreaterThan(0);
    for (const a of ANCHORS_E9_V1) expect(a.facetIds.some((f) => probeFacets.has(f))).toBe(false);
    const firstSensitive = ANCHORS_E9_V1.findIndex((a) => isSensitive(a.facetIds));
    expect(firstSensitive).toBeGreaterThanOrEqual(MIN_ANSWERED);
    expect(ANCHORS_E9_V1.slice(firstSensitive).every((a) => isSensitive(a.facetIds))).toBe(true);
    // The arm is cfg.e7.probes with this opening, asked in order; the default is untouched.
    expect({ ...E9_OPENING_CONFIG, anchors: E7_PROBES_CONFIG.anchors }).toEqual(E7_PROBES_CONFIG);
    expect(E9_OPENING_CONFIG.anchors).toEqual({ setId: 'anchors.e9.v1', count: 8, order: 'fixed' });
    expect(DEFAULT_CONFIG.anchors).toEqual({ setId: 'anchors.v1', count: 10 });
    expect(
      E9_OPENING_CONFIG.selector.type === 'voi' && E9_OPENING_CONFIG.selector.trustRamp?.minAnswered,
    ).toBe(MIN_ANSWERED);
  });

  it('sets up the e9 preset as a draft: cfg.e7.probes against cfg.e9.opening', async () => {
    const fresh = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'e9-preset' });
    try {
      const a = await setupPreset(fresh.deps, 'e9');
      expect(a.created).toBe(true);
      expect(a.experiment.status).toBe('draft');
      expect(a.experiment.name).toBe(EXPERIMENT_PRESETS.e9.name);
      const labels = new Map((await fresh.deps.store.listConfigs()).map((c) => [c.hash, c.label]));
      expect(a.experiment.arms.map((x) => [x.arm, labels.get(x.configHash), x.weight])).toEqual([
        ['control', E7_PROBES_LABEL, 1],
        ['opening', E9_OPENING_LABEL, 1],
      ]);
    } finally {
      fresh.close();
    }
  });

  it('asks the opening in its order, the consented sensitive questions once the ramp is open', async () => {
    const { turns } = await runSession(
      engine,
      script('Consented', { consents: { politics: true, money: true } }),
      {
        turns: 14,
        configHash: opening,
      },
    );
    expect(anchorsServed(turns)).toEqual([...ANCHORS_E9_V1_KEYS]);
    for (const [i, x] of turns.entries())
      if (x.itemKey && isSensitive(ANCHORS_E9_V1.find((a) => a.itemKey === x.itemKey)?.facetIds ?? []))
        expect(i).toBeGreaterThanOrEqual(MIN_ANSWERED);
  }, 120_000);

  it('never seeds a sensitive anchor without its consent', async () => {
    const { turns } = await runSession(engine, script('Unconsented'), { turns: 12, configHash: opening });
    expect(anchorsServed(turns)).toEqual(
      ANCHORS_E9_V1.filter((a) => !isSensitive(a.facetIds)).map((a) => a.itemKey),
    );
  }, 120_000);

  it('holds a sensitive anchor back until six answers, asking other questions first', async () => {
    // Without "Work and money" only three anchors remain: two on deliberation, then political leaning.
    const { turns } = await runSession(
      engine,
      script('Narrow', { categories: ['psychology', 'values'], consents: { politics: true } }),
      { turns: 12, configHash: opening },
    );
    const anchors = anchorsServed(turns);
    expect(anchors).toEqual([
      'reserve.v1/gut_call',
      'reserve.v1/big_purchase',
      'reserve.v2/political_leaning_1',
    ]);
    const political = turns.findIndex((x) => x.itemKey === 'reserve.v2/political_leaning_1');
    expect(political).toBeGreaterThanOrEqual(MIN_ANSWERED);
    // Something other than an anchor was asked between the second anchor and the political one.
    const second = turns.findIndex((x) => x.itemKey === 'reserve.v1/big_purchase');
    expect(turns.slice(second + 1, political).some((x) => x.kind !== 'anchor')).toBe(true);
  }, 120_000);
});
