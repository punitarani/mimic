import type { Facet } from '../types';
import { ANCHOR_SETS, ANCHORS_V1, type ItemTemplate } from './anchors';
import { ANCHORS_E9_V1, ANCHORS_E9_V1_KEYS } from './opening';
import { getReserveSet, RESERVE_SETS, RESERVE_V1, RESERVE_V2, RESERVE_V2_NEW } from './reserve';
import { FACET_GROUPS, ONTOLOGY_V1 } from './v1';
import { FACET_GROUPS_V2, GROUP_CATEGORY_V2, NEW_IN_V2, ONTOLOGY_V2 } from './v2';

export {
  ANCHOR_SETS,
  ANCHORS_E9_V1,
  ANCHORS_E9_V1_KEYS,
  ANCHORS_V1,
  FACET_GROUPS,
  FACET_GROUPS_V2,
  GROUP_CATEGORY_V2,
  getReserveSet,
  type ItemTemplate,
  NEW_IN_V2,
  ONTOLOGY_V1,
  ONTOLOGY_V2,
  RESERVE_SETS,
  RESERVE_V1,
  RESERVE_V2,
  RESERVE_V2_NEW,
};

export const ONTOLOGIES: Record<string, Facet[]> = { v1: ONTOLOGY_V1, v2: ONTOLOGY_V2 };

const GROUPS: Record<string, readonly string[]> = { v1: FACET_GROUPS, v2: FACET_GROUPS_V2 };

/** Every facet of every ontology version by id (a facet id means the same thing in every version). */
export function allOntologyFacets(): Map<string, Facet> {
  return new Map(Object.values(ONTOLOGIES).flatMap((o) => o.map((f) => [f.id, f] as const)));
}

export function getOntology(version: string): Facet[] {
  const o = ONTOLOGIES[version];
  if (!o) throw new Error(`Unknown ontology version: ${version}`);
  return o;
}

/** The facet groups of an ontology version, in display order. */
export function getFacetGroups(version: string): string[] {
  const g = GROUPS[version];
  if (!g) throw new Error(`Unknown ontology version: ${version}`);
  return [...g];
}

/** Every anchor set by id: `anchors.ts`'s own and the openings built from the reserve bank (ADR-0073). */
const ALL_ANCHOR_SETS: Record<string, ItemTemplate[]> = { ...ANCHOR_SETS, 'anchors.e9.v1': ANCHORS_E9_V1 };

export function getAnchorSet(setId: string): ItemTemplate[] {
  const a = ALL_ANCHOR_SETS[setId];
  if (!a) throw new Error(`Unknown anchor set: ${setId}`);
  return a;
}

/** The reserve set a config uses (ADR-0042); configs written before `reserve.setId` existed use reserve.v1. */
export function reserveSetId(cfg: { reserve?: { setId: string } | undefined }): string {
  return cfg.reserve?.setId ?? 'reserve.v1';
}
