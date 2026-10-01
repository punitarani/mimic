import { describe, expect, it } from 'vitest';
import {
  configHash,
  DEFAULT_CONFIG,
  dueProbe,
  E7_PROBES_CONFIG,
  getOntology,
  getReserveSet,
  isProbe,
  PROBE_GENERATOR,
  PROBE_V1,
  type ProbeMeta,
  pickProbe,
  probeMetaOf,
  type QuestionRecord,
  tierOfLoad,
} from '../src';

let n = 0;
function q(over: Partial<QuestionRecord>): QuestionRecord {
  n++;
  return {
    id: `q${n}`,
    mimicId: 'm',
    seq: n,
    kind: 'adaptive',
    type: 'choice',
    domain: 'casual',
    prompt: `Question ${n}?`,
    options: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ],
    facetIds: [],
    itemKey: undefined,
    provenance: { generator: 'test', configHash: 'h', promptVersion: 'p' },
    status: 'answered',
    quality: null,
    createdAt: n,
    servedAt: n,
    stateAt: n,
    ...over,
  };
}
const probe = (meta: Partial<ProbeMeta>, over: Partial<QuestionRecord> = {}) =>
  q({
    provenance: { generator: PROBE_GENERATOR, configHash: 'h', promptVersion: 'probe.v1' },
    quality: { probe: { set: 'probe.v1', slot: 0, index: 0, planned: 'far', tier: 'far', load: 0, ...meta } },
    ...over,
  });

describe('E7 probe schedule (ADR-0062)', () => {
  it('owes slot 0 at once, then waits for non-probe answers, in schedule order', () => {
    expect(dueProbe(PROBE_V1, [])).toEqual({ slot: 0, index: 0, planned: 'shared' });
    const first = probe({ slot: 0, index: 0, planned: 'shared', tier: 'shared' });
    expect(dueProbe(PROBE_V1, [first])).toEqual({ slot: 0, index: 1, planned: 'far' });
    const slot0 = [first, probe({ slot: 0, index: 1 })];
    expect(dueProbe(PROBE_V1, slot0)).toBeNull();
    // Probe answers never move the clock; the session's other answers do, repeats included.
    const anchors = Array.from({ length: 9 }, () => q({ kind: 'anchor' }));
    expect(dueProbe(PROBE_V1, [...slot0, ...anchors])).toBeNull();
    expect(dueProbe(PROBE_V1, [...slot0, ...anchors, q({ kind: 'repeat' })])).toEqual({
      slot: 10,
      index: 0,
      planned: 'near',
    });
    anchors.push(q({ kind: 'anchor' }));
    // A discarded probe is owed again; a repeat of a probe is not a probe.
    const discarded = probe({ slot: 10, index: 0 }, { status: 'discarded' });
    const repeat = probe({ slot: 10, index: 0 }, { kind: 'repeat' });
    expect(isProbe(repeat)).toBe(false);
    expect(probeMetaOf(repeat)).toBeNull();
    expect(dueProbe(PROBE_V1, [...slot0, ...anchors, discarded, repeat])).toEqual({
      slot: 10,
      index: 0,
      planned: 'near',
    });
  });

  it('reads distance from answers on the item facets', () => {
    expect([0, 1, 2, 5].map(tierOfLoad)).toEqual(['far', 'mid', 'near', 'near']);
  });

  it('picks the scheduled shared item, an anchor to repeat, and falls back to the nearest tier it can fill', () => {
    const bank = getReserveSet('reserve.v2');
    const sensitive = new Set(
      getOntology('v2')
        .filter((f) => f.sensitive)
        .map((f) => f.id),
    );
    const allow = (r: { facetIds: string[] }) => !r.facetIds.some((f) => sensitive.has(f));
    const args = { probes: PROBE_V1, bank: 'reserve.v2', mimicId: 'm', allow };
    // Slot 10's shared entry is the second shared item, the same for everyone.
    const shared = pickProbe({ ...args, questions: [], due: { slot: 10, index: 2, planned: 'shared' } })!;
    expect(shared.item.itemKey).toBe(PROBE_V1.shared[1]);
    expect(shared.tier).toBe('shared');
    // Nothing answered: no near or mid item exists, so a near probe is served far and says so.
    const near = pickProbe({ ...args, questions: [], due: { slot: 10, index: 0, planned: 'near' } })!;
    expect(near.tier).toBe('far');
    expect(PROBE_V1.shared).not.toContain(near.item.itemKey);
    expect(near.item.facetIds.some((f) => sensitive.has(f))).toBe(false);
    // Two answers on one facet make a bank item on it near.
    const facet = bank.find((r) => allow(r) && !PROBE_V1.shared.includes(r.itemKey))!.facetIds[0]!;
    const answered = [q({ facetIds: [facet] }), q({ facetIds: [facet] })];
    const close = pickProbe({ ...args, questions: answered, due: { slot: 10, index: 0, planned: 'near' } })!;
    expect(close.tier).toBe('near');
    expect(close.item.facetIds).toContain(facet);
    // A repeat asks the earliest answered anchor again, once.
    const anchor = q({ kind: 'anchor', itemKey: 'anchors.v1/x', seq: 1 });
    const rep = pickProbe({ ...args, questions: [anchor], due: { slot: 30, index: 0, planned: 'repeat' } })!;
    expect(rep).toMatchObject({ tier: 'repeat', sourceId: anchor.id });
    const again = probe({ slot: 30, index: 0, tier: 'repeat', sourceId: anchor.id });
    const second = pickProbe({
      ...args,
      questions: [anchor, again],
      due: { slot: 30, index: 1, planned: 'repeat' },
    })!;
    expect(second.tier).not.toBe('repeat');
  });

  it('cfg.e7.probes is cfg.default.v8 with the probes and a longer session', () => {
    expect({ ...E7_PROBES_CONFIG, probes: undefined, session: DEFAULT_CONFIG.session }).toEqual({
      ...DEFAULT_CONFIG,
      probes: undefined,
    });
    expect(E7_PROBES_CONFIG.session).toEqual({ target: DEFAULT_CONFIG.session.target + 14, budgetUsd: 0.75 });
    expect(configHash(E7_PROBES_CONFIG)).toBe(
      '8d878da4369e72c6cf57affa999abb2bc84d0e6e844f1126ac6fd744670c93d5',
    );
    // Adding the optional field leaves every older config's hash where it was.
    expect(configHash(DEFAULT_CONFIG)).toBe(
      '08956a2222de74c94bb21e6ace0a7a2c69e4d441a41e0cbe4be5a26d638ac44f',
    );
    // The shared items exist, are distinct, and touch no sensitive facet.
    const bank = new Map(getReserveSet('reserve.v2').map((r) => [r.itemKey, r]));
    const sensitive = new Set(
      getOntology('v2')
        .filter((f) => f.sensitive)
        .map((f) => f.id),
    );
    expect(new Set(PROBE_V1.shared).size).toBe(PROBE_V1.shared.length);
    for (const k of PROBE_V1.shared) expect(bank.get(k)?.facetIds.some((f) => sensitive.has(f))).toBe(false);
  });
});
