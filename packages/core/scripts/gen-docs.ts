// Mirrors the ontology, anchors and prompts from packages/core into docs/ (checked by test/docs-sync.test.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsFiles } from '../src/docs';

const root = join(import.meta.dirname, '..', '..', '..');
for (const [path, content] of Object.entries(docsFiles())) {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  console.log(`wrote ${path}`);
}
