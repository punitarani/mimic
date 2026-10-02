import { z } from 'zod';
import { PREDICT_PROMPTS, renderVariantDoc } from './components';
import { MimicJson } from './engine/artifact';
import {
  ANCHORS_E9_V1,
  ANCHORS_V1,
  FACET_GROUPS_V2,
  NEW_IN_V2,
  ONTOLOGY_V1,
  ONTOLOGY_V2,
  RESERVE_V1,
  RESERVE_V2,
  RESERVE_V2_NEW,
} from './ontology';
import { AREA_INFO, CATEGORY_INFO } from './scope';
import type { Facet } from './types';

/** `docs/ontology/v2.sources.md`: every v2 facet with its poles and research anchor, by group (ADR-0042). */
function renderSources(): string {
  const newIds = new Set(NEW_IN_V2.map((f) => f.id));
  const items = (f: Facet) => RESERVE_V2_NEW.filter((r) => r.facetIds.includes(f.id)).length;
  const lines = [
    '# Ontology v2: facets and research anchors',
    '',
    'Generated from `packages/core/src/ontology/v2.ts` by `pnpm --filter @mimic/core gen:docs`; do not edit by hand.',
    'Each facet is read on five labels between its two poles. "New" marks facets added in v2 (ADR-0042); v1 facets',
    "keep their ids, poles and labels. Sensitive facets are asked only with the person's consent for their area",
    '(ADR-0040). "Reserve" counts the reserve.v2 items written for the facet.',
    '',
    `${ONTOLOGY_V2.length} facets: ${ONTOLOGY_V1.length} from v1 and ${NEW_IN_V2.length} new, of which ${
      NEW_IN_V2.filter((f) => f.sensitive).length
    } sensitive.`,
  ];
  for (const g of FACET_GROUPS_V2) {
    const fs = ONTOLOGY_V2.filter((f) => f.group === g);
    lines.push('', `## ${g} (${CATEGORY_INFO[fs[0]!.category].name})`, '');
    lines.push('| Facet | Low → high | Research anchor | New | Sensitive | Reserve |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of fs) {
      const area = f.sensitive ? AREA_INFO[f.sensitive].name : '';
      lines.push(
        `| \`${f.id}\` ${f.name} | ${f.low} → ${f.high} | ${f.source ?? ''} | ${newIds.has(f.id) ? 'yes' : ''} | ${area} | ${
          newIds.has(f.id) ? items(f) : ''
        } |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

import { PROMPTS, renderPromptDoc } from './prompts';

/** Files under docs/ generated from the code (path → content). */
export function docsFiles(): Record<string, string> {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const files: Record<string, string> = {
    'docs/ontology/v1.json': json({ version: 'v1', facets: ONTOLOGY_V1 }),
    'docs/ontology/anchors.v1.json': json({ setId: 'anchors.v1', items: ANCHORS_V1 }),
    'docs/ontology/anchors.e9.v1.json': json({ setId: 'anchors.e9.v1', items: ANCHORS_E9_V1 }),
    'docs/ontology/reserve.v1.json': json({ setId: 'reserve.v1', items: RESERVE_V1 }),
    'docs/ontology/v2.json': json({ version: 'v2', groups: FACET_GROUPS_V2, facets: ONTOLOGY_V2 }),
    'docs/ontology/v2.sources.md': renderSources(),
    'docs/ontology/reserve.v2.json': json({ setId: 'reserve.v2', items: RESERVE_V2 }),
    'docs/schemas/mimic-1.schema.json': json({
      title: 'mimic/1 — a portable mimic snapshot (PLAN §8.1)',
      ...z.toJSONSchema(MimicJson, { unrepresentable: 'any' }),
    }),
  };
  for (const p of Object.values(PROMPTS)) files[`docs/prompts/${p.id}.md`] = renderPromptDoc(p);
  for (const v of Object.values(PREDICT_PROMPTS))
    files[`docs/prompts/variants/${v.id}.md`] = renderVariantDoc(v);
  return files;
}
