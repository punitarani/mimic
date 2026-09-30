import {
  EngineError,
  enqueueMissingShadows,
  Job,
  jobKey,
  MAX_JOB_ATTEMPTS,
  requeueStaleJobs,
  runJob,
  ulid,
  writeSnapshot,
} from '@mimic/core';
import { engineDeps, type MimicBindings } from '@mimic/db/runtime';

export interface Env extends MimicBindings {
  JOBS: Queue<Job>;
}

/** Shadows normally land within seconds; older gaps are lost enqueues (PENDING_WINDOW_MS in the lab is 15 min). */
const SHADOW_GRACE_MS = 10 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deps(env: Env) {
  return engineDeps(env);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const d = deps(env);
      const id = ulid();
      const cfgs = await d.store.listConfigs();
      await d.blobs.put(`health/${id}.json`, JSON.stringify({ at: d.clock() }));
      await d.jobs.enqueue({ type: 'noop', id });
      return json({
        ok: true,
        d1: { configs: cfgs.length },
        r2: `health/${id}.json`,
        enqueued: `noop:${id}`,
      });
    }
    const m = url.pathname.match(/^\/health\/job\/(.+)$/);
    if (m) {
      const job = await deps(env).store.getJob(decodeURIComponent(m[1]!));
      return json({ job });
    }
    return json({ error: 'not found' }, 404);
  },

  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const d = deps(env);
    await Promise.all(
      batch.messages.map(async (msg) => {
        const parsed = Job.safeParse(msg.body);
        if (!parsed.success) {
          console.error('Dropping malformed job', parsed.error.message);
          msg.ack();
          return;
        }
        try {
          const outcome = await runJob(d, parsed.data);
          console.log(`job ${jobKey(parsed.data)} ${outcome}`);
          msg.ack();
        } catch (e) {
          const permanent = e instanceof EngineError && (e.code === 'not_found' || e.code === 'invalid');
          console.error(`job ${jobKey(parsed.data)} failed (attempt ${msg.attempts})`, e);
          if (permanent || msg.attempts >= MAX_JOB_ATTEMPTS) msg.ack();
          else msg.retry({ delaySeconds: Math.min(300, 5 * 3 ** (msg.attempts - 1)) });
        }
      }),
    );
  },

  /**
   * Cron: re-enqueue stale jobs, and write snapshots for mimics whose evidence moved past their last snapshot
   * (session-end safety net).
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const d = deps(env);
    const requeued = await requeueStaleJobs(d);
    if (requeued) console.log(`requeued ${requeued} stale jobs`);
    const recent = (await d.store.listMimics({})).filter((m) => m.updatedAt > Date.now() - 24 * 3600 * 1000);
    let shadows = 0;
    for (const m of recent) {
      try {
        shadows += await enqueueMissingShadows(d, m.id, Date.now() - SHADOW_GRACE_MS);
        await writeSnapshot(d, m.id);
      } catch (e) {
        console.error(`cron ${m.id} failed`, e);
      }
    }
    if (shadows) console.log(`enqueued ${shadows} missing shadows`);
  },
} satisfies ExportedHandler<Env>;
