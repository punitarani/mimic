// node --test scripts/*.test.mjs (part of `pnpm test`). No network: OpenRouter, D1, the queue and the local worker
// are fakes behind the same interfaces. packages/eval/test/backfill.test.ts runs the SQL against the real schema.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  backfill,
  backfillJobs,
  checkModel,
  checkPromptVersion,
  DEFAULT_RATE,
  errorsQuery,
  inFlightQuery,
  inlineParams,
  localTarget,
  MAX_JOBS,
  missingQuery,
  PENDING_WINDOW_MS,
  parseBackfillArgs,
  remoteTarget,
  statsQuery,
} from './backfill.mjs';
import { cloudflare } from './deploy/lib.mjs';

const MIMO = 'llm:xiaomi/mimo-v2.6-pro';
const M1 = '01K6B9Z3Y1Q2W3E4R5T6Y7V8X9';
const M2 = '01K6B9Z3Y1Q2W3E4R5T6Y7V8XA';
const NOW = 1_800_000_000_000;
const quiet = () => {};

const openRouter = async () =>
  Response.json({
    data: [
      {
        id: 'xiaomi/mimo-v2.6-pro',
        name: 'Xiaomi: MiMo-V2.6-Pro',
        supported_parameters: ['structured_outputs'],
      },
      { id: 'qwen/qwen3.8-flash', name: 'Qwen: Qwen3.8 Flash', supported_parameters: ['structured_outputs'] },
      { id: 'acme/plain', name: 'Plain', supported_parameters: ['temperature'] },
    ],
  });

describe('backfill arguments', () => {
  it('parses a predictor, environment, scope, pace and confirmation', () => {
    assert.deepEqual(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--consented', '--yes']), {
      predictors: [MIMO],
      env: 'prod',
      consented: true,
      mimics: [],
      rate: DEFAULT_RATE,
      retryFailed: false,
      yes: true,
    });
    assert.equal(parseBackfillArgs(['--predictor', MIMO]).env, 'local');
    const o = parseBackfillArgs(['--predictor', MIMO, '--rate', '12', '--retry-failed']);
    assert.equal(o.rate, 12);
    assert.equal(o.retryFailed, true);
    // Prompt variants (ADR-0028) are accepted; anything that could break out of the inlined SQL is not.
    assert.deepEqual(
      parseBackfillArgs(['--predictor', 'decision:typesafe/jev-1.13@jev-predict.v2']).predictors,
      ['decision:typesafe/jev-1.13@jev-predict.v2'],
    );
    // `jev:` (before ADR-0052) is the same predictor, named canonically.
    assert.deepEqual(
      parseBackfillArgs([
        '--predictor',
        'jev:typesafe/jev-1.13@jev-predict.v2,decision:typesafe/jev-1.13@jev-predict.v2',
      ]).predictors,
      ['decision:typesafe/jev-1.13@jev-predict.v2'],
    );
    assert.throws(
      () => parseBackfillArgs(['--predictor', 'JEV:typesafe/jev-1.13']),
      /--predictor must look like/,
    );
    assert.throws(
      () => parseBackfillArgs(['--predictor', `${MIMO}@v2'; drop`]),
      /--predictor must look like/,
    );
  });

  it('takes several predictors, repeated or as a list', () => {
    const QWEN = 'llm:qwen/qwen3.8-flash';
    assert.deepEqual(parseBackfillArgs(['--predictor', `${MIMO}, ${QWEN}`]).predictors, [MIMO, QWEN]);
    assert.deepEqual(
      parseBackfillArgs(['--predictor', MIMO, '--predictor', QWEN, '--predictor', MIMO]).predictors,
      [MIMO, QWEN],
    );
  });

  it('refuses malformed predictors, environments, mimic IDs and rates', () => {
    assert.throws(() => parseBackfillArgs([]), /--predictor/);
    assert.throws(() => parseBackfillArgs(['--predictor', "llm:x/y'; drop table mimics"]), /--predictor/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--env', 'staging']), /--env/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--mimic', 'abc']), /not a mimic ID/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--force']), /unknown argument/);
    for (const r of ['0', '-3', 'fast', '1000', '2.5'])
      assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--rate', r]), /--rate/);
  });
});

describe('backfill plan', () => {
  it('counts served, sealed questions without the predictor or a job in flight, scoped like the worker', () => {
    const q = missingQuery({ predictor: MIMO, consented: true, mimics: [M1], retryFailed: false }, NOW);
    assert.match(q.sql, /q\.kind IN \('anchor', 'adaptive'\)/);
    assert.match(q.sql, /p\.role = 'primary'/);
    // Either spelling of the predictor counts as present (ADR-0052), as does a job keyed by either.
    assert.match(q.sql, /p\.predictor_id IN \(\?1, \?4\) AND p\.role != 'hypothesis' \)/);
    assert.match(q.sql, /'predict\.shadow:' \|\| q\.mimic_id \|\| ':' \|\| q\.id \|\| ':' \|\| \?4/);
    assert.match(q.sql, /q\.served_at < \?2/);
    assert.match(q.sql, /AND NOT EXISTS \(SELECT 1 FROM jobs j WHERE j\.key IN/);
    assert.match(q.sql, /j\.updated_at >= \?3/);
    assert.match(q.sql, /m\.consent_research = 1/);
    assert.match(q.sql, /q\.mimic_id IN \(\?5\)/);
    // Strings only: the D1 HTTP API's params are strings. An LLM ID has one spelling.
    assert.deepEqual(q.params, [MIMO, String(NOW - PENDING_WINDOW_MS), String(NOW - 15 * 60_000), MIMO, M1]);
    const jev = missingQuery(
      { predictor: 'decision:typesafe/jev-1.13', consented: false, mimics: [], retryFailed: false },
      NOW,
    );
    assert.equal(jev.params[3], 'jev:typesafe/jev-1.13');
    assert.doesNotMatch(
      missingQuery({ predictor: MIMO, consented: false, mimics: [], retryFailed: false }, NOW).sql,
      /consent|q\.mimic_id IN/,
    );
  });

  it('with --retry-failed, counts a failed call as missing, from the stored error kind', () => {
    const { sql } = missingQuery({ predictor: MIMO, consented: false, mimics: [], retryFailed: true }, NOW);
    assert.match(sql, /AND NOT \(p\.role = 'shadow' AND p\.ok = 0 AND p\.error_kind = 'transport'\)\)/);
  });

  it('reports failures by kind, and backfill predictions in flight', () => {
    assert.match(
      statsQuery(MIMO).sql,
      /AS unusable,.*AS timeouts,.*AS failed_calls,.*AS redoable,.*AS avg_cost/s,
    );
    assert.match(errorsQuery(MIMO).sql, /GROUP BY 1, 2 ORDER BY n DESC/);
    assert.deepEqual(inFlightQuery(MIMO, NOW).params, [MIMO, String(NOW - 15 * 60_000), MIMO]);
    assert.deepEqual(statsQuery('decision:typesafe/jev-1.13').params, [
      'decision:typesafe/jev-1.13',
      'jev:typesafe/jev-1.13',
    ]);
    assert.match(errorsQuery(MIMO).sql, /p\.predictor_id IN \(\?1, \?2\)/);
  });

  it('inlines parameters for wrangler, quoting strings', () => {
    assert.equal(
      inlineParams('a = ?1 AND b IN (?2) AND c < ?3', ["x'y", M1, 42]),
      `a = 'x''y' AND b IN ('${M1}') AND c < 42`,
    );
  });

  it('publishes one paced job, or one staggered job per named mimic with something missing', () => {
    const one = { predictor: MIMO, consented: true, mimics: [], rate: 30, retryFailed: false };
    assert.deepEqual(backfillJobs(one, [], 'R'), [
      { type: 'backfill.predictor', runId: 'R', predictorId: MIMO, consentedOnly: true, perMinute: 30 },
    ]);
    const named = { ...one, consented: false, mimics: [M1, M2], rate: 20, retryFailed: true };
    const rows = [
      { mimic: M1, missing: 10 },
      { mimic: M2, missing: 4 },
    ];
    const base = { type: 'backfill.mimic', runId: 'R', predictorId: MIMO, perMinute: 20, retryFailed: true };
    assert.deepEqual(backfillJobs(named, rows, 'R'), [
      { ...base, mimicId: M1, offsetSeconds: 0 },
      // M1's 10 predictions take 30 s at 20 a minute, so M2 starts after them.
      { ...base, mimicId: M2, offsetSeconds: 30 },
    ]);
    // --consented with named mimics: their predictions check consent again when they run.
    const consented = backfillJobs({ ...named, consented: true }, rows.slice(0, 1), 'R');
    assert.equal(consented[0].consentedOnly, true);
  });

  it('accepts only OpenRouter models with structured outputs', async () => {
    assert.match(await checkModel(MIMO, openRouter), /MiMo-V2\.6-Pro on OpenRouter/);
    await assert.rejects(checkModel('llm:acme/typo', openRouter), /not an OpenRouter model/);
    await assert.rejects(checkModel('llm:acme/plain', openRouter), /structured outputs/);
    assert.match(await checkModel('decision:typesafe/jev-1.13', openRouter), /Decisions API/);
    assert.match(await checkModel('decision:respan/span-01-20260925', openRouter), /Decisions API/);
    // A prompt variant must be registered (mirrored to docs/prompts/variants/) and not the incumbent.
    await assert.rejects(checkModel(`${MIMO}@predict.v9`, openRouter), /not a registered prompt variant/);
    await assert.rejects(checkModel(`${MIMO}@predict.v1`, openRouter), /names the incumbent prompt/);
    await assert.rejects(checkModel(`${MIMO}@jev-predict.v1`, openRouter), /incumbent|not a llm/);
    const dir = mkdtempSync(join(tmpdir(), 'variants-'));
    mkdirSync(join(dir, 'docs/prompts/variants'), { recursive: true });
    writeFileSync(join(dir, 'docs/prompts/variants/predict.v2.md'), '- Predictor kind: `llm` (use as …)\n');
    assert.equal(checkPromptVersion(`${MIMO}@predict.v2`, dir), 'predict.v2');
    assert.throws(
      () => checkPromptVersion('jev:typesafe/jev-1.13@predict.v2', dir),
      /not a decision prompt variant/,
    );
    // The generated docs name the decision kind (ADR-0052); a `jev:` ID reads them as such.
    writeFileSync(
      join(dir, 'docs/prompts/variants/jev-predict.v2.md'),
      '- Predictor kind: `decision` (use as …)\n',
    );
    assert.equal(checkPromptVersion('jev:typesafe/jev-1.13@jev-predict.v2', dir), 'jev-predict.v2');
    assert.equal(checkPromptVersion('decision:typesafe/jev-1.13@jev-predict.v2', dir), 'jev-predict.v2');
    assert.throws(
      () => checkPromptVersion('jev:typesafe/jev-1.13@jev-predict.v1', dir),
      /use decision:typesafe/,
    );
  });
});

const STATS = {
  n: 20,
  ok: 12,
  unusable: 4,
  timeouts: 1,
  failed_calls: 3,
  redoable: 3,
  charged: 16,
  avg_cost: 0.0002,
};
const ERRORS = [
  { kind: 'output', error: 'output cut off at max_tokens (3000; 3000 output tokens)', n: 4 },
  { kind: 'transport', error: 'HTTP 429 from openrouter.ai: rate limited', n: 3 },
];

/** A deployed environment: D1 answers the four queries; the queue records what was pushed. */
function fakeRemote({
  missing = [{ mimic: M1, missing: 12 }],
  stats = STATS,
  errors = ERRORS,
  flight = { n: 0, last: null },
} = {}) {
  const pushed = [];
  const queries = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/client/v4/accounts/acc', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (result) => Response.json({ success: true, errors: [], result });
    if (path === '/d1/database')
      return ok([
        { uuid: 'db1', name: 'mimic-prod' },
        { uuid: 'x', name: 'mimic-prod-old' },
      ]);
    if (path === '/d1/database/db1/query') {
      queries.push(body);
      assert.ok(
        body.params.every((x) => typeof x === 'string'),
        'D1 HTTP params are strings',
      );
      const sql = body.sql;
      const results = sql.startsWith('SELECT COUNT(*) AS n, COALESCE')
        ? [stats]
        : sql.startsWith('SELECT COALESCE(p.error_kind')
          ? errors
          : sql.startsWith('SELECT COUNT(*) AS n, MAX(j.updated_at)')
            ? [flight]
            : missing;
      return ok([{ results }]);
    }
    if (path === '/queues') return ok([{ queue_id: 'q1', queue_name: 'mimic-jobs-prod' }]);
    if (path === '/queues/q1/messages' && init.method === 'POST') {
      pushed.push(body);
      return ok(null);
    }
    return Response.json({ success: false, errors: [{ code: 404, message: path }] }, { status: 404 });
  };
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl });
  return { target: remoteTarget('prod', cf), pushed, queries };
}

describe('backfill run', () => {
  it('is a dry run by default: counts, explains failures and estimates, enqueues nothing', async () => {
    const { target, pushed } = fakeRemote();
    const lines = [];
    const r = await backfill(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod']), target, {
      fetchImpl: openRouter,
      log: (l) => lines.push(l),
    });
    assert.deepEqual(r, { missing: 12, enqueued: 0 });
    assert.equal(pushed.length, 0);
    const has = (s) =>
      assert.ok(
        lines.some((l) => l.includes(s)),
        `no line with "${s}" in:\n${lines.join('\n')}`,
      );
    has('so far: 20 prediction(s), 8 failed (40.0%)');
    has("the model's (kept): 4 unusable output, 1 timed out");
    has("failed calls (not the model's): 3; --retry-failed redoes 3");
    has('4 × output: output cut off at max_tokens');
    has('3 × transport: HTTP 429');
    has('missing: 12 prediction(s) across 1 mimic(s)');
    has('$0.00020 per prediction over 16 so far');
    has('about $0.0024 for these');
    has('pace: 30 a minute, under a minute');
    assert.ok(!lines.some((l) => l.includes('in flight')));
    assert.ok(!lines.some((l) => l.includes('re-run for the rest')));
    assert.ok(lines.at(-1).startsWith('Dry run'));
  });

  it('says what is already in flight, and when a run stops at its cap', async () => {
    const { target } = fakeRemote({
      missing: [{ mimic: M1, missing: MAX_JOBS + 700 }],
      flight: { n: 40, last: NOW + 20 * 60_000 },
    });
    const lines = [];
    await backfill(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--rate', '600']), target, {
      fetchImpl: openRouter,
      log: (l) => lines.push(l),
      now: NOW,
    });
    assert.ok(lines.some((l) => l.includes('in flight: 40 queued or retrying, due within about 20 min')));
    assert.ok(lines.some((l) => l.includes(`this run enqueues the first ${MAX_JOBS}`)));
    // At 1 a minute, 12 h holds 721 predictions.
    const slow = fakeRemote({ missing: [{ mimic: M1, missing: 800 }] });
    const slowLines = [];
    await backfill(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--rate', '1']), slow.target, {
      fetchImpl: openRouter,
      log: (l) => slowLines.push(l),
    });
    assert.ok(slowLines.some((l) => l.includes('this run enqueues the first 721')));
    assert.ok(slowLines.some((l) => l.includes('pace: 1 a minute, about 12.0 h')));
  });

  it('with --yes publishes one paced job to the environment queue', async () => {
    const { target, pushed } = fakeRemote();
    const opts = parseBackfillArgs([
      '--predictor',
      MIMO,
      '--env',
      'prod',
      '--consented',
      '--rate',
      '10',
      '--yes',
    ]);
    const r = await backfill(opts, target, { fetchImpl: openRouter, log: quiet, runId: 'R' });
    assert.deepEqual(r, { missing: 12, enqueued: 1 });
    assert.deepEqual(pushed, [
      {
        body: {
          type: 'backfill.predictor',
          runId: 'R',
          predictorId: MIMO,
          consentedOnly: true,
          perMinute: 10,
        },
      },
    ]);
  });

  it('passes --retry-failed to the query and the job', async () => {
    const { target, pushed, queries } = fakeRemote();
    const opts = parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--retry-failed', '--yes']);
    await backfill(opts, target, { fetchImpl: openRouter, log: quiet, runId: 'R' });
    assert.ok(queries.some((q) => q.sql.includes('AND NOT (p.role')));
    assert.equal(pushed[0].body.retryFailed, true);
  });

  it('enqueues one job per predictor, and nothing at all if any model fails its check', async () => {
    const QWEN = 'llm:qwen/qwen3.8-flash';
    const { target, pushed } = fakeRemote();
    const opts = parseBackfillArgs(['--predictor', `${MIMO},${QWEN}`, '--env', 'prod', '--yes']);
    assert.deepEqual(await backfill(opts, target, { fetchImpl: openRouter, log: quiet, runId: 'R' }), {
      missing: 24,
      enqueued: 2,
    });
    assert.deepEqual(
      pushed.map((p) => p.body.predictorId),
      [MIMO, QWEN],
    );

    const bad = fakeRemote();
    const withTypo = parseBackfillArgs(['--predictor', `${MIMO},llm:acme/typo`, '--env', 'prod', '--yes']);
    await assert.rejects(
      backfill(withTypo, bad.target, { fetchImpl: openRouter, log: quiet }),
      /not an OpenRouter/,
    );
    assert.equal(bad.pushed.length, 0);
  });

  it('does nothing when nothing is missing, even with --yes', async () => {
    const { target, pushed } = fakeRemote({
      missing: [],
      stats: { n: 0, ok: 0, charged: 0, avg_cost: null },
    });
    const opts = parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--yes']);
    assert.deepEqual(await backfill(opts, target, { fetchImpl: openRouter, log: quiet }), {
      missing: 0,
      enqueued: 0,
    });
    assert.equal(pushed.length, 0);
  });

  it('locally, queries the dev D1 through wrangler and posts to the dev worker', async () => {
    const calls = [];
    const exec = async (_cmd, args) => {
      const sql = args.at(-1);
      calls.push(sql);
      const results = sql.startsWith('SELECT COUNT(*) AS n')
        ? [{ n: 0 }]
        : sql.startsWith('SELECT q.mimic_id')
          ? [{ mimic: M1, missing: 3 }]
          : [];
      return JSON.stringify([{ results }]);
    };
    const posted = [];
    const fetchImpl = async (url, init) => {
      if (String(url).startsWith('https://openrouter.ai')) return openRouter();
      posted.push([url, JSON.parse(init.body)]);
      return Response.json({ enqueued: 'k' });
    };
    const opts = parseBackfillArgs(['--predictor', MIMO, '--mimic', M1, '--yes']);
    await backfill(opts, localTarget({ fetchImpl, exec }), { fetchImpl, log: quiet, runId: 'R', now: NOW });
    const missing = calls.find((s) => s.startsWith('SELECT q.mimic_id'));
    assert.ok(missing.includes(`p.predictor_id IN ('${MIMO}', '${MIMO}')`), 'parameters are inlined');
    assert.ok(missing.includes(`q.served_at < '${NOW - PENDING_WINDOW_MS}'`), 'numbers go as strings');
    assert.deepEqual(posted, [
      [
        'http://127.0.0.1:8787/__jobs',
        {
          type: 'backfill.mimic',
          runId: 'R',
          mimicId: M1,
          predictorId: MIMO,
          perMinute: DEFAULT_RATE,
          offsetSeconds: 0,
        },
      ],
    ]);
  });
});
