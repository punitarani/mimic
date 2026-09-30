import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

/** A static file's content hash, for a `?v=` that changes with the file: link previews cache images by URL. */
const version = (file: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(file, import.meta.url)))
    .digest('hex')
    .slice(0, 10);

const nextConfig: NextConfig = {
  transpilePackages: ['@mimic/core', '@mimic/db', '@mimic/adapters'],
  turbopack: { root: '../..' },
  poweredByHeader: false,
  agentRules: false,
  // The dev badge overlaps the session's action area in screenshots.
  devIndicators: false,
  // Inlined at build time (lib/site.ts, ADR-0031). A deploy sets SITE_URL to the environment's public origin, its
  // custom domain or workers.dev URL (scripts/deploy); local builds fall back to next dev's origin.
  env: {
    SITE_URL: process.env.SITE_URL || 'http://localhost:3000',
    SHARE_CARD_VERSION: version('./public/share-card.png'),
    APPLE_ICON_VERSION: version('./public/apple-touch-icon.png'),
    ICON_VERSION: version('./public/icon.svg'),
  },
  // Persona.md became SOUL.md (ADR-0037); links and bookmarks to the old paths keep working.
  async redirects() {
    return [
      { source: '/m/:id/persona', destination: '/m/:id/soul', permanent: true },
      { source: '/api/mimics/:id/persona.md', destination: '/api/mimics/:id/soul.md', permanent: true },
    ];
  },
};

export default nextConfig;

// Local bindings are initialized lazily in lib/server.ts (see devContext) so every Next process shares
// ../../.wrangler/state with `wrangler dev` of apps/worker.
