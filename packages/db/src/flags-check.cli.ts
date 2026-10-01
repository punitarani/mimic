// Entry point of `pnpm flags:check` (through scripts/deploy/flags.mjs, which passes the app ID).
import { flagsCheckCli } from './flags-check';

flagsCheckCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  },
);
