import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@mimic/core', '@mimic/db', '@mimic/adapters'],
  turbopack: { root: '../..' },
  poweredByHeader: false,
  agentRules: false,
};

export default nextConfig;

// Local bindings (D1/R2/KV/Queues) shared with `wrangler dev` of apps/worker via the same persist dir.
initOpenNextCloudflareForDev({ persist: { path: '../../.wrangler/state/v3' } });
