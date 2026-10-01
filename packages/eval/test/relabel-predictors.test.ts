import {
  canonicalPredictorId,
  DECISION_MODELS,
  DECISION_PREFIX,
  decisionChallenger,
  FLAG_KEYS,
  JEV_MODEL,
  LEGACY_DECISION_PREFIX,
  predictorIdSpellings,
  SPAN_MODEL,
  StaticFlags,
} from '@mimic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ids from '../../../scripts/predictor-ids.mjs';
import * as cli from '../../../scripts/relabel-predictors.mjs';
import { type LocalEngine, openLocalEngine } from '../src/local';
import { runSession, SessionScript } from '../src/session';

// `pnpm relabel:predictors` (ADR-0054) on the real schema: rows stored before ADR-0054 (`jev:`, and span-01 answers
// under Jev's ID) end up exactly as the new code stores them.
const script = SessionScript.parse({
  intake: { name: 'Sam Rivera', location: 'Austin, US', occupation: 'Software engineer' },
  consentResearch: true,
});
const SPAN = `decision:${SPAN_MODEL}@jev-predict.v2`;
const TWIN = 'decision:typesafe/jev-1.13';

let engine: LocalEngine;
/** What the new code stored: prediction ID → predictor ID. */
let expected: Map<string, string>;
let twinLoser: string;
let spanMimic: string;
const log: string[] = [];

const exec = async (sql: string, args: string[] = []) => (await engine.client.execute({ sql, args })).rows;
const target = { name: 'test', query: async (q: { sql: string; params: string[] }) => exec(q.sql, q.params) };
const opts = (o: Partial<ReturnType<typeof cli.parseRelabelArgs>> = {}) => ({
  ...cli.parseRelabelArgs([]),
  ...o,
});
const stored = async () =>
  new Map(
    (await exec('SELECT id, predictor_id FROM predictions')).map((r) => [
      String(r.id),
      String(r.predictor_id),
    ]),
  );
const checksum = async () =>
  String(
    (
      await exec(
        "SELECT group_concat(id || '=' || predictor_id, ',') AS s FROM (SELECT * FROM predictions ORDER BY id)",
      )
    )[0]!.s,
  );

beforeAll(async () => {
  engine = await openLocalEngine({ db: ':memory:', providers: 'offline', seed: 'relabel' });
  let mode: 'jev' | 'span-01' = 'jev';
  engine.deps.gateway.deps.decisionRouter = decisionChallenger(
    new StaticFlags({ [FLAG_KEYS.decisionsModel]: () => mode }),
  );
  await runSession(engine, script, { turns: 10 });
  mode = 'span-01';
  spanMimic = (await runSession(engine, script, { turns: 10 })).mimicId;

  // A shadow of a decision predictor, stored twice for one question: once by old code (`jev:`, a success, later) and
  // once by new code (`decision:`, a failed call, earlier). Each has a score.
  const [shadow] = await exec("SELECT id FROM predictions WHERE role = 'shadow' LIMIT 1");
  const copy = async (id: string, predictorId: string, ok: number, createdAt: number) => {
    const rest = [
      'question_id, mimic_id, role, dist_json, confidence, state_hash, evidence_seq_max, config_hash, prompt_version',
      'model_snapshot, cost_usd, latency_ms, error, error_kind, fallback, hypothesis',
    ].join(', ');
    await exec(
      `INSERT INTO predictions (id, predictor_id, ok, created_at, ${rest})
         SELECT ?1, ?2, ?3, ?4, ${rest} FROM predictions WHERE id = ?5`,
      [id, predictorId, String(ok), String(createdAt), String(shadow!.id)],
    );
    const cols = 'answer_id, mimic_id, top1, item_acc, log_loss, brier, created_at';
    await exec(
      `INSERT INTO scores (prediction_id, ${cols}) SELECT ?1, ${cols} FROM scores WHERE prediction_id = ?2`,
      [id, String(shadow!.id)],
    );
  };
  await copy('TWIN-OLD', `jev:${TWIN.slice('decision:'.length)}`, 1, 2_000);
  await copy('TWIN-NEW', TWIN, 0, 1_000);
  twinLoser = 'TWIN-NEW';
  expected = await stored();
  expected.set('TWIN-OLD', TWIN);
  expected.delete(twinLoser);

  // What the code before ADR-0054 stored: `jev:`, and span-01's served answers under Jev's ID.
  await exec(
    "UPDATE predictions SET predictor_id = 'jev:' || substr(predictor_id, 10) WHERE substr(predictor_id, 1, 9) = 'decision:' AND id <> 'TWIN-NEW'",
  );
  await exec('UPDATE predictions SET predictor_id = ?1 WHERE predictor_id = ?2', [
    'jev:typesafe/jev-1.13@jev-predict.v2',
    `jev:${SPAN_MODEL}@jev-predict.v2`,
  ]);
}, 180_000);

afterAll(() => engine?.close());

describe('pnpm relabel:predictors (ADR-0054)', () => {
  it("mirrors core's spellings and pinned models", () => {
    expect(ids.DECISION_PREFIX).toBe(DECISION_PREFIX);
    expect(ids.LEGACY_DECISION_PREFIX).toBe(LEGACY_DECISION_PREFIX);
    expect(ids.JEV_MODEL).toBe(JEV_MODEL);
    expect(ids.DECISION_MODELS).toEqual(DECISION_MODELS);
    for (const id of ['jev:typesafe/jev-1.13@jev-predict.v2', 'decision:x/y', 'llm:a/b@predict.v2', 'nope']) {
      expect(ids.canonicalPredictorId(id)).toBe(canonicalPredictorId(id));
      expect(ids.predictorIdSpellings(id)).toEqual(predictorIdSpellings(id));
    }
    // Snapshots are matched by prefix, so no pinned model may be a prefix of another.
    const models = Object.values(DECISION_MODELS);
    for (const a of models) for (const b of models) if (a !== b) expect(b.startsWith(a)).toBe(false);
    expect(cli.CHALLENGERS).toEqual([['span-01', SPAN_MODEL]]);
  });

  it('a dry run counts each step and changes nothing', async () => {
    const before = await checksum();
    const r = await cli.relabel(opts(), target, { log: (l) => log.push(l) });
    expect(await checksum()).toBe(before);
    const legacy = Number(
      (await exec("SELECT COUNT(*) AS n FROM predictions WHERE predictor_id LIKE 'jev:%'"))[0]!.n,
    );
    expect(r.legacy).toBe(legacy);
    expect(r.legacy).toBeGreaterThan(30);
    expect(r.twins).toBe(1);
    const span = [...expected.values()].filter((p) => p === SPAN).length;
    expect(span).toBeGreaterThan(10);
    expect(r.served).toBe(span);
    expect(log.join('\n')).toMatch(/Dry run: nothing changed/);
    expect(log.join('\n')).toMatch(/no unrecognized snapshots/);
  });

  it('--yes rewrites every row to what the new code stores, in batches', async () => {
    const r = await cli.relabel(opts({ yes: true, batch: 7 }), target, { log: () => {} });
    expect(r.rewritten).toBeGreaterThan(30);
    expect(await stored()).toEqual(expected);
    // The worse twin went, with its score; the better one is the canonical row.
    expect(await exec('SELECT 1 FROM predictions WHERE id = ?1', [twinLoser])).toHaveLength(0);
    expect(await exec('SELECT 1 FROM scores WHERE prediction_id = ?1', [twinLoser])).toHaveLength(0);
    expect((await exec('SELECT 1 FROM scores WHERE prediction_id = ?1', ['TWIN-OLD'])).length).toBe(1);
    // span-01's rows are its own, with the prompt version and config they had.
    const span = await engine.deps.store.listPredictions({
      mimicId: spanMimic,
      roles: ['primary', 'baseline'],
    });
    expect(span.every((p) => p.predictorId === SPAN && p.promptVersion === 'jev-predict.v2')).toBe(true);
    // Configs are hashed: they keep `jev:`.
    const configs = await exec('SELECT json FROM configs');
    expect(configs.some((c) => String(c.json).includes('"jev:typesafe/jev-1.13@jev-predict.v2"'))).toBe(true);
  });

  it('is idempotent: a second run finds nothing', async () => {
    const before = await checksum();
    expect(await cli.relabel(opts({ yes: true }), target, { log: () => {} })).toEqual({
      legacy: 0,
      twins: 0,
      served: 0,
      rewritten: 0,
    });
    expect(await checksum()).toBe(before);
  });

  it('--reverse restores jev: for a rollback, keeping span-01 as span-01; forward again is the same state', async () => {
    const r = await cli.relabel(opts({ yes: true, reverse: true }), target, { log: () => {} });
    expect(r.rewritten).toBe([...expected.values()].filter((p) => p.startsWith('decision:')).length);
    const back = await stored();
    for (const [id, p] of expected) expect(back.get(id)).toBe(p.replace(/^decision:/, 'jev:'));
    expect(
      await exec('SELECT 1 FROM predictions WHERE predictor_id = ?1', [`jev:${SPAN_MODEL}@jev-predict.v2`]),
    ).not.toHaveLength(0);
    await cli.relabel(opts({ yes: true }), target, { log: () => {} });
    expect(await stored()).toEqual(expected);
  });

  it('stops when a batch makes no progress', async () => {
    const stuck = {
      name: 'stuck',
      query: async (q: { sql: string }) =>
        q.sql.startsWith('SELECT role, COUNT(*) AS n, MAX') ? [{ role: 'primary', n: 3 }] : [],
    };
    await expect(cli.relabel(opts({ yes: true }), stuck, { log: () => {} })).rejects.toThrow(/no progress/);
  });
});
