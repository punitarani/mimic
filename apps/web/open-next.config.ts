import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Every page is dynamic and per-person; no incremental cache is needed.
export default defineCloudflareConfig({});
