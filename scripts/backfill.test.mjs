// node --test scripts/*.test.mjs (part of `pnpm test`). No network: OpenRouter, D1, the queue and the local worker
// are fakes behind the same interfaces.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  backfill,
  backfillJobs,
  checkModel,
  inlineParams,
  localTarget,
  missingQuery,
  parseBackfillArgs,
  remoteTarget,
} from './backfill.mjs';
import { cloudflare } from './deploy/lib.mjs';

const MIMO = 'llm:xiaomi/mimo-v2.6-pro';
const M1 = '01K6B9Z3Y1Q2W3E4R5T6Y7V8X9';
const quiet = () => {};

const openRouter = async () =>
  Response.json({
    data: [
      {
        id: 'xiaomi/mimo-v2.6-pro',
        name: 'Xiaomi: MiMo-V2.6-Pro',
        supported_parameters: ['structured_outputs'],
      },
      { id: 'acme/plain', name: 'Plain', supported_parameters: ['temperature'] },
    ],
  });

describe('backfill arguments', () => {
  it('parses a predictor, environment, scope and confirmation', () => {
    assert.deepEqual(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--consented', '--yes']), {
      predictor: MIMO,
      env: 'prod',
      consented: true,
      mimics: [],
      yes: true,
    });
    assert.equal(parseBackfillArgs(['--predictor', MIMO]).env, 'local');
  });

  it('refuses malformed predictors, environments and mimic IDs', () => {
    assert.throws(() => parseBackfillArgs([]), /--predictor/);
    assert.throws(() => parseBackfillArgs(['--predictor', "llm:x/y'; drop table mimics"]), /--predictor/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--env', 'staging']), /--env/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--mimic', 'abc']), /not a mimic ID/);
    assert.throws(() => parseBackfillArgs(['--predictor', MIMO, '--force']), /unknown argument/);
  });
});

describe('backfill plan', () => {
  it('counts served, sealed questions without the predictor, scoped like the worker', () => {
    const q = missingQuery({ predictor: MIMO, consented: true, mimics: [M1] });
    assert.match(q.sql, /q\.kind IN \('anchor', 'adaptive'\)/);
    assert.match(q.sql, /p\.role = 'primary'/);
    assert.match(q.sql, /p\.predictor_id = \?1/);
    assert.match(q.sql, /m\.consent_research = 1/);
    assert.match(q.sql, /q\.mimic_id IN \(\?2\)/);
    assert.deepEqual(q.params, [MIMO, M1]);
    assert.doesNotMatch(
      missingQuery({ predictor: MIMO, consented: false, mimics: [] }).sql,
      /consent|IN \(\?/,
    );
  });

  it('inlines parameters for wrangler, quoting them', () => {
    assert.equal(inlineParams('a = ?1 AND b IN (?2)', ["x'y", M1]), `a = 'x''y' AND b IN ('${M1}')`);
  });

  it('publishes one fan-out job, or one job per named mimic', () => {
    assert.deepEqual(backfillJobs({ predictor: MIMO, consented: true, mimics: [] }, 'R'), [
      { type: 'backfill.predictor', runId: 'R', predictorId: MIMO, consentedOnly: true },
    ]);
    assert.deepEqual(backfillJobs({ predictor: MIMO, consented: false, mimics: [M1] }, 'R'), [
      { type: 'backfill.mimic', runId: 'R', mimicId: M1, predictorId: MIMO },
    ]);
  });

  it('accepts only OpenRouter models with structured outputs', async () => {
    assert.match(await checkModel(MIMO, openRouter), /MiMo-V2\.6-Pro on OpenRouter/);
    await assert.rejects(checkModel('llm:acme/typo', openRouter), /not an OpenRouter model/);
    await assert.rejects(checkModel('llm:acme/plain', openRouter), /structured outputs/);
    assert.match(await checkModel('jev:typesafe/jev-1.13', openRouter), /Jev/);
  });
});

/** A deployed environment: D1 answers the two queries; the queue records what was pushed. */
function fakeRemote({ missing = [{ mimic: M1, missing: 12 }], cost = { n: 4, avg: 0.0002 } } = {}) {
  const pushed = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/client/v4/accounts/acc', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const ok = (result) => Response.json({ success: true, errors: [], result });
    if (path === '/d1/database')
      return ok([
        { uuid: 'db1', name: 'mimic-prod' },
        { uuid: 'x', name: 'mimic-prod-old' },
      ]);
    if (path === '/d1/database/db1/query')
      return ok([{ results: body.sql.startsWith('SELECT COUNT(*) AS n') ? [cost] : missing }]);
    if (path === '/queues') return ok([{ queue_id: 'q1', queue_name: 'mimic-jobs-prod' }]);
    if (path === '/queues/q1/messages' && init.method === 'POST') {
      pushed.push(body);
      return ok(null);
    }
    return Response.json({ success: false, errors: [{ code: 404, message: path }] }, { status: 404 });
  };
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl });
  return { target: remoteTarget('prod', cf), pushed };
}

describe('backfill run', () => {
  it('is a dry run by default: counts and estimates, enqueues nothing', async () => {
    const { target, pushed } = fakeRemote();
    const lines = [];
    const r = await backfill(parseBackfillArgs(['--predictor', MIMO, '--env', 'prod']), target, {
      fetchImpl: openRouter,
      log: (l) => lines.push(l),
    });
    assert.deepEqual(r, { missing: 12, enqueued: 0 });
    assert.equal(pushed.length, 0);
    assert.ok(lines.some((l) => l.includes('missing: 12 prediction(s) across 1 mimic(s)')));
    assert.ok(lines.some((l) => l.includes('about $0.0024 for these')));
    assert.ok(lines.some((l) => l.startsWith('Dry run')));
  });

  it('with --yes publishes the job to the environment queue', async () => {
    const { target, pushed } = fakeRemote();
    const opts = parseBackfillArgs(['--predictor', MIMO, '--env', 'prod', '--consented', '--yes']);
    const r = await backfill(opts, target, { fetchImpl: openRouter, log: quiet, runId: 'R' });
    assert.deepEqual(r, { missing: 12, enqueued: 1 });
    assert.deepEqual(pushed, [
      { body: { type: 'backfill.predictor', runId: 'R', predictorId: MIMO, consentedOnly: true } },
    ]);
  });

  it('does nothing when nothing is missing, even with --yes', async () => {
    const { target, pushed } = fakeRemote({ missing: [], cost: { n: 0, avg: null } });
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
      return JSON.stringify([
        { results: sql.startsWith('SELECT COUNT(*) AS n') ? [{ n: 0 }] : [{ mimic: M1, missing: 3 }] },
      ]);
    };
    const posted = [];
    const fetchImpl = async (url, init) => {
      if (String(url).startsWith('https://openrouter.ai')) return openRouter();
      posted.push([url, JSON.parse(init.body)]);
      return Response.json({ enqueued: 'k' });
    };
    const opts = parseBackfillArgs(['--predictor', MIMO, '--mimic', M1, '--yes']);
    await backfill(opts, localTarget({ fetchImpl, exec }), { fetchImpl, log: quiet, runId: 'R' });
    assert.ok(calls[0].includes(`p.predictor_id = '${MIMO}'`), 'parameters are inlined');
    assert.deepEqual(posted, [
      [
        'http://127.0.0.1:8787/__jobs',
        { type: 'backfill.mimic', runId: 'R', mimicId: M1, predictorId: MIMO },
      ],
    ]);
  });
});
