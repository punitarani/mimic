import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

// Pages are per-person and dynamic, except the few prerendered at build time (/new, the icon), which never
// revalidate. Those are served from the Worker's static assets, and cache interception answers them before the Next
// server loads. No R2/KV incremental cache, tag cache or revalidation queue: nothing uses ISR or revalidateTag.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
