import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolingPromptDocs } from '../src/optimize/reflect';

describe('optimizer prompt docs mirror the code', () => {
  it('docs/prompts/optimize is up to date (run `pnpm --filter @mimic/eval gen:docs`)', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const [path, content] of Object.entries(toolingPromptDocs()))
      expect(readFileSync(join(root, path), 'utf8'), path).toBe(content);
  });
});
