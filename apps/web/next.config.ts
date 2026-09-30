import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@mimic/core', '@mimic/db', '@mimic/adapters'],
  turbopack: { root: '../..' },
  poweredByHeader: false,
  agentRules: false,
};

export default nextConfig;

// Local bindings are initialized lazily in lib/server.ts (see devContext) so every Next process shares
// ../../.wrangler/state with `wrangler dev` of apps/worker.
