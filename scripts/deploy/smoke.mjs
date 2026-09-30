// A deploy that isn't checked is a hope. After each deploy: the landing page is the real page, its link preview
// points at a card served on this host, /api/health reaches D1, R2, the queue and every flag (ADR-0050), and the lab
// is behind Access (never a 200 without a login).

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
      name: 'Link preview',
      async run() {
        const html = await fetchImpl(`${base}/`).then((r) => r.text());
        const image = html
          .match(/<meta property="og:image" content="([^"]+)"/)?.[1]
          ?.replaceAll('&amp;', '&');
        if (!image) return 'no og:image on /';
        // A build without SITE_URL points previews at localhost (ADR-0031).
        if (!image.startsWith(`${base}/`)) return `og:image is ${image}, not on ${base}`;
        const res = await fetchImpl(image);
        const type = res.headers.get('content-type') ?? '';
        if (res.status !== 200 || !type.startsWith('image/png'))
          return `${image} returned ${res.status} ${type}`;
        return null;
      },
    },
    {
      name: 'GET /api/health',
      async run() {
        const res = await fetchImpl(`${base}/api/health`);
        const json = await res.json().catch(() => null);
        if (res.status !== 200 || json?.ok !== true) return `returned ${res.status} ${JSON.stringify(json)}`;
        // Every flag evaluates through the Worker's FLAGS binding (ADR-0050); an unbound environment reports none.
        if (json.flags?.ok === false) {
          const bad = Object.entries(json.flags.flags ?? {}).filter(([, f]) => !f.ok);
          return `flags don't evaluate: ${bad.map(([k, f]) => `${k} (${f.errorCode ?? JSON.stringify(f.value)})`).join(', ')}`;
        }
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
