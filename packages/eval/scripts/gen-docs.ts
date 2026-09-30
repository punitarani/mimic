// Mirrors the optimizer's prompts into docs/prompts/optimize/ (checked by test/docs-sync.test.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toolingPromptDocs } from '../src/optimize/reflect';

const root = join(import.meta.dirname, '..', '..', '..');
for (const [path, content] of Object.entries(toolingPromptDocs())) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`wrote ${path}`);
}
