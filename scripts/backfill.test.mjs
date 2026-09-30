// node --test scripts/*.test.mjs (part of `pnpm test`). No network: OpenRouter, D1, the queue and the local worker
// are fakes behind the same interfaces. packages/eval/test/backfill.test.ts runs the SQL against the real schema.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  backfill,
  backfillJobs,
  checkModel,
  DEFAULT_RATE,
  errorsQuery,
  inlineParams,
  localTarget,
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
    for (const r of ['0', '-3', 'fast', '1000'])
      assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--rate', r]), /--rate/);
  });
});

describe('backfill plan', () => {
  it('counts served, sealed questions without the predictor, scoped like the worker', () => {
    const q = missingQuery({ predictor: MIMO, consented: true, mimics: [M1], retryFailed: false }, NOW);
    assert.match(q.sql, /q\.kind IN \('anchor', 'adaptive'\)/);
    assert.match(q.sql, /p\.role = 'primary'/);
    assert.match(q.sql, /p\.predictor_id = \?1 \)/);
    assert.match(q.sql, /q\.served_at < \?2/);
    assert.match(q.sql, /m\.consent_research = 1/);
    assert.match(q.sql, /q\.mimic_id IN \(\?3\)/);
    assert.deepEqual(q.params, [MIMO, NOW - PENDING_WINDOW_MS, M1]);
    assert.doesNotMatch(
      missingQuery({ predictor: MIMO, consented: false, mimics: [], retryFailed: false }, NOW).sql,
      /consent|IN \(\?/,
    );
  });

  it('with --retry-failed, counts a failed call as missing but never unusable output', () => {
    const { sql } = missingQuery({ predictor: MIMO, consented: false, mimics: [], retryFailed: true }, NOW);
    assert.match(
      sql,
      /AND NOT \(p\.role = 'shadow' AND p\.ok = 0 AND NOT COALESCE\(p\.error IN \('invalid JSON/,
    );
    assert.match(sql, /'output cut off at max_tokens%'/);
  });

  it('reports failures by kind and message', () => {
    assert.match(statsQuery(MIMO).sql, /AS unusable,.*AS failed_calls,.*AS avg_cost/s);
    assert.match(errorsQuery(MIMO).sql, /GROUP BY 1 ORDER BY n DESC/);
  });

  it('inlines parameters for wrangler, quoting strings and keeping numbers numeric', () => {
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
    assert.deepEqual(backfillJobs(named, rows, 'R'), [
      {
        type: 'backfill.mimic',
        runId: 'R',
        mimicId: M1,
        predictorId: MIMO,
        perMinute: 20,
        retryFailed: true,
        offsetSeconds: 0,
      },
      // M1's 10 predictions take 30 s at 20 a minute, so M2 starts after them.
      {
        type: 'backfill.mimic',
        runId: 'R',
        mimicId: M2,
        predictorId: MIMO,
        perMinute: 20,
        retryFailed: true,
        offsetSeconds: 30,
      },
    ]);
  });

  it('accepts only OpenRouter models with structured outputs', async () => {
    assert.match(await checkModel(MIMO, openRouter), /MiMo-V2\.6-Pro on OpenRouter/);
    await assert.rejects(checkModel('llm:acme/typo', openRouter), /not an OpenRouter model/);
    await assert.rejects(checkModel('llm:acme/plain', openRouter), /structured outputs/);
    assert.match(await checkModel('jev:typesafe/jev-1.13', openRouter), /Jev/);
  });
});

const STATS = { n: 20, ok: 12, unusable: 5, failed_calls: 3, charged: 17, avg_cost: 0.0002 };
const ERRORS = [
  { error: 'output cut off at max_tokens (3000; 3000 output tokens)', n: 5, unusable: 1 },
  { error: 'HTTP 429 from openrouter.ai: rate limited', n: 3, unusable: 0 },
];

/** A deployed environment: D1 answers the three queries; the queue records what was pushed. */
function fakeRemote({ missing = [{ mimic: M1, missing: 12 }], stats = STATS, errors = ERRORS } = {}) {
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
      const results = body.sql.startsWith('SELECT COUNT(*) AS n')
        ? [stats]
        : body.sql.startsWith('SELECT substr')
          ? errors
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
    has("unusable output (the model's; kept): 5");
    has("failed calls (not the model's): 3, redo with --retry-failed");
    has('5 × output cut off at max_tokens');
    has('missing: 12 prediction(s) across 1 mimic(s)');
    has('$0.00020 per prediction over 17 so far');
    has('about $0.0024 for these');
    has('pace: 30 a minute, under a minute');
    assert.ok(lines.at(-1).startsWith('Dry run'));
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
    assert.ok(missing.includes(`p.predictor_id = '${MIMO}'`), 'parameters are inlined');
    assert.ok(missing.includes(`q.served_at < ${NOW - PENDING_WINDOW_MS}`), 'numbers stay numbers');
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
