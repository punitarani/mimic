import {
  createMimic,
  exportMimic,
  exportSoul,
  importObservations,
  listObservations,
  loadMimicData,
  OBSERVATIONS_SCHEMA,
  ObservationBatch,
  observationProblem,
  serveNext,
  submitAnswer,
} from '@mimic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

let engine: LocalEngine;
afterEach(() => engine?.close());

async function person(turns: number) {
  const m = await createMimic(
    engine.deps,
    {
      name: 'Noor Haddad',
      location: 'Leeds, UK',
      occupation: 'Pharmacist',
      attestSelf: true,
      consentSearch: false,
      consentResearch: true,
    },
    'p-noor',
  );
  await engine.drain();
  for (let i = 0; i < turns; i++) {
    const next = await serveNext(engine.deps, m.id);
    if (next.status !== 'question') throw new Error(next.status);
    await engine.drain((j) => j.type !== 'snapshot.write');
    await submitAnswer(engine.deps, m.id, {
      questionId: next.question.id,
      value: next.question.options[0]!.key,
      latencyMs: 900,
      idempotencyKey: `k-${m.id}-${i}`,
    });
    await engine.drain();
  }
  return m;
}

const batch = (over: Partial<ObservationBatch> = {}) =>
  ObservationBatch.parse({
    schema: OBSERVATIONS_SCHEMA,
    writer: { agent: 'hermes-agent/0.4', note: 'from the travel thread' },
    observations: [
      {
        id: 'flight-1',
        at: 1_760_000_000_000,
        type: 'choice',
        prompt: 'Two flights home: cheaper with a long layover, or direct for £80 more?',
        options: [
          { key: 'a', label: 'The cheaper one with the layover' },
          { key: 'b', label: 'The direct flight' },
        ],
        answer: 'b',
        why: 'I value the evening at home more than £80.',
        context: 'booking a trip back from a conference',
        authority: 'stated',
      },
      {
        id: 'reply-2',
        at: 1_760_000_100_000,
        type: 'noul',
        prompt: 'Reply to the recruiter who messaged you?',
        options: [
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ],
        answer: 'no',
      },
    ],
    ...over,
  });

describe('observation ledger (ADR-0060)', () => {
  it('appends observations as taught answers the mimic learns from, idempotently, and names the agent', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await person(6);
    const r = await importObservations(engine.deps, m.id, batch());
    expect(r).toMatchObject({
      writer: 'hermes-agent/0.4',
      accepted: 2,
      duplicates: 0,
      rejected: 0,
      learns: true,
    });
    expect(r.outcomes.map((o) => o.seq)).toEqual([7, 8]);
    await engine.drain();
    // The observations are feedback evidence: they enter the data the state builder reads, with their context.
    const loaded = await loadMimicData(engine.deps, await engine.deps.store.getMimic(m.id).then((x) => x!));
    const obs = loaded.data.evidence.filter((e) => e.kind === 'feedback');
    expect(obs.map((e) => e.answer)).toEqual(['b', 'no']);
    expect(obs[0]!.why).toBe(
      'I value the evening at home more than £80. Context: booking a trip back from a conference',
    );
    // Re-sending the same batch changes nothing.
    const again = await importObservations(engine.deps, m.id, batch());
    expect(again).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
    expect(again.outcomes.map((o) => o.seq)).toEqual([7, 8]);
    // The record lists them newest first, with the agent and the authority.
    const list = await listObservations(engine.deps, m.id);
    expect(list.map((o) => [o.seq, o.agent, o.authority, o.id])).toEqual([
      [8, 'hermes-agent/0.4', 'observed', 'reply-2'],
      [7, 'hermes-agent/0.4', 'stated', 'flight-1'],
    ]);
    expect(list[1]!.context).toBe('booking a trip back from a conference');
    // Exports say where each answer came from, and SOUL.md marks what an agent observed.
    const doc = await exportMimic(engine.deps, m.id);
    const sources = doc.evidence.map((e) => `${e.seq}:${e.source}${e.agent ? `:${e.agent}` : ''}`);
    expect(sources.slice(0, 2)).toEqual(['1:session', '2:session']);
    expect(sources.slice(-2)).toEqual(['7:agent:hermes-agent/0.4', '8:agent:hermes-agent/0.4']);
    const md = await exportSoul(engine.deps, m.id);
    expect(md).toContain('_(observed by hermes-agent/0.4)_');
    expect(md).toContain('**The direct flight**');
  }, 60_000);

  it('rejects what an agent may not write, one observation at a time', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline' });
    const m = await person(3);
    const bad = batch({
      observations: [
        ...batch().observations.slice(0, 1),
        {
          id: 'vote-3',
          at: 1,
          type: 'noul',
          prompt: 'Did you vote for the incumbent in the election?',
          options: [
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ],
          answer: 'yes',
          authority: 'observed',
        },
        {
          id: 'bad-key',
          at: 1,
          type: 'choice',
          prompt: 'Tea or coffee this morning?',
          options: [
            { key: 'a', label: 'Tea' },
            { key: 'b', label: 'Coffee' },
          ],
          answer: 'c',
          authority: 'observed',
        },
        { ...batch().observations[0]!, id: 'flight-1' },
      ],
    });
    const r = await importObservations(engine.deps, m.id, bad);
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(3);
    expect(r.outcomes.map((o) => [o.id, o.status])).toEqual([
      ['flight-1', 'accepted'],
      ['vote-3', 'rejected'],
      ['bad-key', 'rejected'],
      ['flight-1', 'rejected'],
    ]);
    expect(r.outcomes[1]!.reason).toMatch(/politics/);
    expect(r.outcomes[3]!.reason).toMatch(/repeated id/);
    expect(observationProblem(bad.observations[2]!)).toMatch(/not one of the options/);
    // The ledger's writer name and shape are checked before anything is stored.
    expect(() => batch({ writer: { agent: 'bad agent name!' } })).toThrow();
    expect(() => ObservationBatch.parse({ ...batch(), schema: 'mimic-observations/2' })).toThrow();
  }, 60_000);
});
