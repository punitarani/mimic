import { afterEach, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { renderReport } from '../src/report';
import { runSession, SessionScript } from '../src/session';
import { buildPopulation, POPULATION_SCHEMA } from '../src/synthesize';

let engine: LocalEngine;
afterEach(() => engine?.close());

const script = (name: string, seed: string) =>
  SessionScript.parse({
    intake: { name, location: 'Lisbon, PT', occupation: 'Nurse' },
    consentResearch: true,
    seed,
    whys: { 'free afternoon': `A private reason from ${name}` },
  });

describe('population builder (ADR-0055)', () => {
  it('builds a seeded synthetic population from a consented cohort, with realism metrics and no identity', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'population' });
    for (let i = 0; i < 6; i++)
      await runSession(engine, script(`Cohort Person ${i}`, `seed-${i}`), { turns: 14 });
    const spec = {
      name: 'pop',
      split: 'all' as const,
      population: 'all' as const,
      agents: 12,
      k: 3,
      kappa: 10,
      minPeople: 5,
      seed: 'pop',
    };
    const { doc, run } = await buildPopulation(engine.deps, spec, 'hash');
    expect(doc.schema).toBe(POPULATION_SCHEMA);
    expect(doc.source.people).toBe(6);
    expect(doc.agents).toHaveLength(12);
    expect(doc.dims.length).toBeGreaterThan(5);
    expect(doc.fit.weight).toBeCloseTo(6 / 16);
    // Every anchor was answered by all six people; items below the minimum never appear.
    expect(doc.items.every((it) => it.people >= 5)).toBe(true);
    expect(doc.items.length).toBeGreaterThanOrEqual(10);
    for (const a of doc.agents) {
      for (const v of Object.values(a.facets)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Object.keys(a.readings)).toEqual(Object.keys(a.facets));
      expect(a.answers.length).toBe(doc.items.length);
      expect(a.concordia.prefab).toBe('basic__Entity');
      expect(a.concordia.memories.length).toBeGreaterThan(0);
      expect(a.smallville.learned).toContain('typed questions');
    }
    expect(doc.questionnaire.length).toBeGreaterThan(0);
    expect(doc.questionnaire[0]).toMatchObject({
      dimension: expect.any(String),
      ascending: expect.any(Boolean),
    });
    // Realism is measured against the cohort; a copy would re-identify everyone, a mixture should not.
    expect(doc.realism.dims.length).toBe(doc.dims.length);
    expect(Number.isFinite(doc.realism.meanDispersionRatio)).toBe(true);
    expect(doc.realism.identifiability).toBeLessThanOrEqual(1);
    // No names, reasons or ids of real people reach the artifact.
    const text = JSON.stringify(doc);
    expect(text).not.toContain('Cohort Person');
    expect(text).not.toContain('A private reason');
    expect(text).not.toContain('Lisbon');
    const mimics = await engine.deps.store.listMimics({});
    for (const m of mimics) expect(text).not.toContain(m.id);
    // Deterministic from the seed.
    const again = await buildPopulation(engine.deps, spec, 'hash');
    expect(again.doc.agents).toEqual(doc.agents);
    const other = await buildPopulation(engine.deps, { ...spec, seed: 'other' }, 'hash');
    expect(other.doc.agents).not.toEqual(doc.agents);
    const md = renderReport(run);
    expect(md).toContain('Mean dispersion ratio');
    expect(md).toContain('| Identifiability |');
  }, 120_000);

  it('builds nothing from fewer people than the minimum, and keeps scripted people out by default', async () => {
    engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'population-small' });
    for (let i = 0; i < 3; i++) await runSession(engine, script(`Few ${i}`, `few-${i}`), { turns: 12 });
    const base = {
      name: 'pop',
      split: 'all' as const,
      agents: 5,
      k: 3,
      kappa: 10,
      minPeople: 5,
      seed: 'pop',
    };
    const { doc } = await buildPopulation(engine.deps, { ...base, population: 'all' }, 'hash');
    expect(doc.source.people).toBe(3);
    expect(doc.dims).toEqual([]);
    expect(doc.agents).toEqual([]);
    const real = await buildPopulation(engine.deps, { ...base, population: 'real' }, 'hash');
    expect(real.doc.source.people).toBe(0);
  }, 60_000);
});
