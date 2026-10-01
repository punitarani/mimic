// node --test scripts/*.test.mjs (part of `pnpm test`). No network: D1 is a fake behind the target interface.
// packages/eval/test/relabel-predictors.test.ts runs the SQL against the real schema.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localTarget } from './backfill.mjs';
import {
  countQuery,
  DEFAULT_BATCH,
  parseRelabelArgs,
  relabel,
  rewriteQuery,
  servedCountQuery,
  servedRewriteQuery,
  twinDeleteQueries,
} from './relabel-predictors.mjs';

const quiet = () => {};
const SPAN = 'respan/span-01-20260925';

/**
 * A database that answers counts from `rows` and shrinks them as batches run, recording every statement.
 * `legacy` rows to rewrite, `served` span-01 rows under Jev's ID, `twins` shadows under both spellings.
 */
function fakeDb({ legacy = 0, served = 0, twins = 0 } = {}) {
  const sql = [];
  const state = { legacy, served, twins };
  return {
    sql,
    state,
    target: {
      name: 'fake',
      async query(q) {
        sql.push(q.sql);
        const batch = Number(/LIMIT (\d+)/.exec(q.sql)?.[1] ?? 0);
        if (q.sql.startsWith('SELECT role, COUNT(*) AS n, MAX'))
          return state.legacy ? [{ role: 'primary', n: state.legacy, newest: 1 }] : [];
        if (q.sql.startsWith('SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM scores'))
          return [{ n: state.twins, scores: state.twins }];
        if (q.sql.startsWith('SELECT role, COUNT(*) AS n FROM predictions'))
          return state.served ? [{ role: 'primary', n: state.served }] : [];
        if (q.sql.startsWith('DELETE FROM predictions')) state.twins = 0;
        if (q.sql.startsWith("UPDATE predictions SET predictor_id = 'decision:' || ?2"))
          state.served = Math.max(0, state.served - batch);
        else if (q.sql.startsWith('UPDATE')) state.legacy = Math.max(0, state.legacy - batch);
        return [];
      },
    },
  };
}

describe('relabel arguments', () => {
  it('defaults to a local dry run, and validates the rest', () => {
    assert.deepEqual(parseRelabelArgs([]), {
      env: 'local',
      batch: DEFAULT_BATCH,
      reverse: false,
      yes: false,
    });
    assert.deepEqual(parseRelabelArgs(['--env', 'prod', '--batch', '50', '--reverse', '--yes']), {
      env: 'prod',
      batch: 50,
      reverse: true,
      yes: true,
    });
    assert.throws(() => parseRelabelArgs(['--env', 'staging']), /--env/);
    for (const b of ['0', '-1', '2.5', 'many', '5001'])
      assert.throws(() => parseRelabelArgs(['--batch', b]), /--batch/);
    assert.throws(() => parseRelabelArgs(['--force']), /unknown argument/);
  });
});

describe('relabel SQL', () => {
  it('rewrites the prefix in either direction, a batch at a time', () => {
    assert.match(countQuery(false).sql, /WHERE substr\(predictor_id, 1, 4\) = 'jev:'/);
    assert.match(countQuery(true).sql, /WHERE substr\(predictor_id, 1, 9\) = 'decision:'/);
    const fwd = rewriteQuery(false, 7).sql;
    assert.match(fwd, /SET predictor_id = 'decision:' \|\| substr\(predictor_id, 5\)/);
    assert.match(fwd, /WHERE substr\(predictor_id, 1, 4\) = 'jev:' LIMIT 7\)/);
    assert.match(rewriteQuery(true, 7).sql, /SET predictor_id = 'jev:' \|\| substr\(predictor_id, 10\)/);
  });

  it('relabels served rows by their snapshot, keeping the prompt version, with model IDs as parameters', () => {
    const q = servedRewriteQuery(SPAN, 3);
    assert.deepEqual(q.params, ['typesafe/jev-1.13', SPAN]);
    assert.match(
      q.sql,
      /SET predictor_id = 'decision:' \|\| \?2 \|\| substr\(predictor_id, length\(\?1\) \+ 10\)/,
    );
    assert.match(q.sql, /role IN \('primary', 'baseline', 'hypothesis'\)/);
    assert.match(q.sql, /substr\(model_snapshot, 1, length\(\?2\)\) = \?2/);
    assert.doesNotMatch(q.sql, /'jev:'/);
    // A dry run counts them under either spelling, since the prefix rewrite hasn't run.
    assert.match(servedCountQuery(SPAN, ['decision:', 'jev:']).sql, /'jev:' \|\| \?1/);
  });

  it("dedupes twins by migration 0006's rule, scores first", () => {
    const [scores, predictions] = twinDeleteQueries().map((q) => q.sql);
    assert.match(scores, /^DELETE FROM scores WHERE prediction_id IN \(SELECT p\.id/);
    assert.match(predictions, /^DELETE FROM predictions WHERE id IN \(SELECT p\.id/);
    assert.match(
      predictions,
      /o\.ok > p\.ok OR \(o\.ok = p\.ok AND \(o\.created_at < p\.created_at OR \(o\.created_at = p\.created_at AND o\.id < p\.id\)\)\)/,
    );
  });
});

describe('relabel', () => {
  it('a dry run only reads', async () => {
    const { sql, target } = fakeDb({ legacy: 12, served: 3, twins: 1 });
    const lines = [];
    const r = await relabel(parseRelabelArgs([]), target, { log: (l) => lines.push(l) });
    assert.deepEqual(r, { legacy: 12, twins: 1, served: 3, rewritten: 0 });
    assert.ok(sql.every((s) => s.startsWith('SELECT')));
    assert.match(lines.at(-1), /Dry run: nothing changed/);
  });

  it('applies the steps in order, in batches, and stops at zero', async () => {
    const { sql, state, target } = fakeDb({ legacy: 12, served: 3, twins: 1 });
    const r = await relabel(parseRelabelArgs(['--yes', '--batch', '5']), target, { log: quiet });
    assert.deepEqual(r, { legacy: 12, twins: 1, served: 3, rewritten: 12 });
    assert.deepEqual(state, { legacy: 0, served: 0, twins: 0 });
    const writes = sql.filter((s) => !s.startsWith('SELECT')).map((s) => s.slice(0, 40));
    assert.deepEqual(writes, [
      'DELETE FROM scores WHERE prediction_id I',
      'DELETE FROM predictions WHERE id IN (SEL',
      ...Array(3).fill("UPDATE predictions SET predictor_id = 'd"),
      "UPDATE predictions SET predictor_id = 'd",
    ]);
  });

  it('--reverse rewrites the prefix only', async () => {
    const { sql, target } = fakeDb({ legacy: 4, served: 9 });
    const lines = [];
    await relabel(parseRelabelArgs(['--reverse', '--yes']), target, { log: (l) => lines.push(l) });
    assert.ok(sql.some((s) => s.startsWith("UPDATE predictions SET predictor_id = 'jev:'")));
    assert.ok(!sql.some((s) => s.includes('model_snapshot') && s.startsWith('UPDATE')));
    // Job keys are never rewritten: the rolled-back code is told about the `decision:` ones it can't run.
    assert.ok(sql.some((s) => s.includes("instr(key, ':decision:')")));
    assert.ok(lines.some((l) => /jobs keyed decision: still queued or retrying: 0/.test(l)));
  });

  it('stops when a batch changes nothing', async () => {
    const target = {
      name: 'stuck',
      query: async (q) =>
        q.sql.startsWith('SELECT role, COUNT(*) AS n, MAX') ? [{ role: 'primary', n: 2 }] : [],
    };
    await assert.rejects(relabel(parseRelabelArgs(['--yes']), target, { log: quiet }), /no progress/);
  });

  it('explains a duplicate that appeared while it ran', async () => {
    const target = {
      name: 'racing',
      query: async (q) => {
        if (q.sql.startsWith('UPDATE')) throw new Error('UNIQUE constraint failed: predictions.question_id');
        return q.sql.startsWith('SELECT role, COUNT(*) AS n, MAX') ? [{ role: 'shadow', n: 1 }] : [];
      },
    };
    await assert.rejects(
      relabel(parseRelabelArgs(['--yes']), target, { log: quiet }),
      /old code still running/,
    );
  });

  it('locally, runs through wrangler with the parameters inlined', async () => {
    const calls = [];
    const exec = async (_cmd, args) => {
      calls.push(args.at(-1));
      return JSON.stringify([{ results: [] }]);
    };
    await relabel(parseRelabelArgs([]), localTarget({ exec }), { log: quiet });
    assert.ok(calls.some((s) => s.includes(`substr(model_snapshot, 1, length('${SPAN}')) = '${SPAN}'`)));
    assert.ok(
      calls.every((s) => !/\?\d/.test(s)),
      'no parameter is left unbound',
    );
  });
});
