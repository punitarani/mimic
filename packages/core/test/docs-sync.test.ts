import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docsFiles } from '../src/docs';

describe('docs mirror the code', () => {
  it('docs/ontology and docs/prompts are up to date (run `pnpm --filter @mimic/core gen:docs`)', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const [path, content] of Object.entries(docsFiles())) {
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(content);
    }
  });
});
