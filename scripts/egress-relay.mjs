#!/usr/bin/env node
// ADR-0002: local egress relay for `pnpm dev`.
//
// workerd (wrangler dev) and some Node clients do not route through the environment's HTTPS proxy, so provider
// calls from local Workers would skip the proxy that injects credentials. The adapters rewrite
// `https://host/path` to `http://127.0.0.1:8790/host/path` when EGRESS_RELAY is set; this relay forwards the
// request with Node's proxy-aware fetch. Only allowlisted provider hosts are forwarded; it binds to 127.0.0.1.
import http from 'node:http';

const PORT = Number(process.env.EGRESS_RELAY_PORT ?? 8790);
const ALLOWED = new Set(['openrouter.ai', 'api.exa.ai', 'api.parallel.ai', 'api.perplexity.ai']);

if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
  console.warn(
    '[egress] HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not; start via `pnpm dev` or set NODE_USE_ENV_PROXY=1',
  );
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'host',
  'content-length',
  'accept-encoding',
]);

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const [, host, ...rest] = (req.url ?? '/').split('/');
    if (!host || !ALLOWED.has(host)) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: `host not allowed: ${host}` }));
      return;
    }
    const target = `https://${host}/${rest.join('/')}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers))
      if (!HOP_BY_HOP.has(k) && typeof v === 'string') headers[k] = v;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
    res.writeHead(upstream.status, outHeaders).end(body);
    const path = new URL(target).pathname;
    console.log(`[egress] ${req.method} ${host}${path} → ${upstream.status} ${Date.now() - started}ms`);
  } catch (e) {
    console.error('[egress] error', e);
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[egress] relay on http://127.0.0.1:${PORT}`));
