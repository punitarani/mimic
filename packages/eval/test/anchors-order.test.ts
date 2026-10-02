import { ANCHORS_V1, createMimic, DEFAULT_CONFIG, IntakeInput, registerConfig } from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LocalEngine, openLocalEngine } from '../src/local';

/** ADR-0072: an anchor set may fix its order; without the field, intake shuffles it per person as before. */

let engine: LocalEngine;
beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'anchors-order' });
});
afterAll(() => engine.close());

const intake = (name: string) =>
  IntakeInput.parse({
    name,
    location: 'Lisbon, PT',
    attestSelf: true,
    consentSearch: false,
    consentResearch: true,
  });

async function anchorKeys(configHash: string, name: string): Promise<string[]> {
  const m = await createMimic(engine.deps, intake(name), `p-${name}`, { configHash });
  return (await engine.deps.store.listQuestions(m.id))
    .filter((q) => q.kind === 'anchor')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((q) => q.itemKey!);
}

describe('anchor order (ADR-0072)', () => {
  it('seeds a fixed set in its own order for everyone, and shuffles the default per person', async () => {
    const setOrder = ANCHORS_V1.map((a) => a.itemKey);
    const fixed = await registerConfig(
      engine.deps,
      { ...DEFAULT_CONFIG, anchors: { ...DEFAULT_CONFIG.anchors, order: 'fixed' } },
      'test.anchors.fixed',
    );
    for (const name of ['Ana', 'Ben', 'Caro']) expect(await anchorKeys(fixed, name)).toEqual(setOrder);

    const shuffled = await registerConfig(engine.deps, DEFAULT_CONFIG, 'test.anchors.default');
    expect(DEFAULT_CONFIG.anchors.order).toBeUndefined();
    const orders = await Promise.all(['Dee', 'Eli', 'Fay'].map((n) => anchorKeys(shuffled, n)));
    for (const o of orders) expect([...o].sort()).toEqual([...setOrder].sort());
    expect(orders.some((o) => o.join() !== setOrder.join())).toBe(true);
    expect(new Set(orders.map((o) => o.join())).size).toBeGreaterThan(1);
  });
});
