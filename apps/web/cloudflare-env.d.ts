import type { MimicBindings } from '@mimic/db/runtime';

declare global {
  interface CloudflareEnv extends MimicBindings {
    ASSETS?: Fetcher;
    DEV_MODE?: string;
  }
}
