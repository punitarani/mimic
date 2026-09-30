import { z } from 'zod';
import { MimicJson } from './engine/artifact';
import { ANCHORS_V1, ONTOLOGY_V1, RESERVE_V1 } from './ontology';
import { PROMPTS, renderPromptDoc } from './prompts';

/** Files under docs/ generated from the code (path → content). */
export function docsFiles(): Record<string, string> {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const files: Record<string, string> = {
    'docs/ontology/v1.json': json({ version: 'v1', facets: ONTOLOGY_V1 }),
    'docs/ontology/anchors.v1.json': json({ setId: 'anchors.v1', items: ANCHORS_V1 }),
    'docs/ontology/reserve.v1.json': json({ setId: 'reserve.v1', items: RESERVE_V1 }),
    'docs/schemas/mimic-1.schema.json': json({
      title: 'mimic/1 — a portable mimic snapshot (PLAN §8.1)',
      ...z.toJSONSchema(MimicJson, { unrepresentable: 'any' }),
    }),
  };
  for (const p of Object.values(PROMPTS)) files[`docs/prompts/${p.id}.md`] = renderPromptDoc(p);
  return files;
}
