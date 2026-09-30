import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

// Pages are per-person and dynamic, except /new, which is prerendered at build time and never revalidates. It is
// served from the Worker's static assets, and cache interception answers it before the Next server loads. Icons and
// the link preview card are plain files in public/ (ADR-0031). No R2/KV incremental cache, tag cache or revalidation queue: nothing uses ISR or revalidateTag.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
