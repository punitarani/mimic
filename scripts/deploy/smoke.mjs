// A deploy that isn't checked is a hope. After each deploy: the landing page is the real page, /api/health
// reaches D1, R2 and the queue, and the lab is behind Access (never a 200 without a login).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function smoke(
  appUrl,
  { fetchImpl = fetch, attempts = 30, delayMs = 10_000, log = console.log } = {},
) {
  const base = appUrl.replace(/\/$/, '');
  const checks = [
    {
      name: 'GET /',
      async run() {
        const res = await fetchImpl(`${base}/`, { redirect: 'manual' });
        const text = await res.text();
        if (res.status !== 200) return `returned ${res.status}`;
        // A Next error boundary also answers 200; the landing copy proves the real page rendered.
        if (!text.includes('Build your mimic')) return '200 without the landing copy';
        return null;
      },
    },
    {
      name: 'GET /api/health',
      async run() {
        const res = await fetchImpl(`${base}/api/health`);
        const json = await res.json().catch(() => null);
        if (res.status !== 200 || json?.ok !== true) return `returned ${res.status} ${JSON.stringify(json)}`;
        return null;
      },
    },
    {
      name: 'GET /lab is behind Access',
      async run() {
        const res = await fetchImpl(`${base}/lab`, { redirect: 'manual' });
        const location = res.headers.get('location') ?? '';
        if (res.status === 200) return 'returned 200 without a login: the lab is public';
        if (res.status >= 300 && res.status < 400 && !location.includes('cloudflareaccess.com'))
          return `redirected to ${location || 'nowhere'}, not to Cloudflare Access`;
        return null;
      },
    },
  ];
  // The first deploy of a custom domain can take a minute to serve; retry the whole set before failing.
  let failures = [];
  for (let i = 1; i <= attempts; i++) {
    failures = [];
    for (const c of checks) {
      const problem = await c.run().catch((e) => `failed: ${e.message}`);
      if (problem) failures.push(`${c.name}: ${problem}`);
    }
    if (!failures.length) {
      for (const c of checks) log(`  ok ${c.name}`);
      return;
    }
    if (i < attempts) {
      log(`  not ready (${failures[0]}); retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
  throw new Error(`smoke test failed on ${base}:\n  - ${failures.join('\n  - ')}`);
}
