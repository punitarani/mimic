import type { Facet } from '../types';
import { ANCHOR_SETS, ANCHORS_V1, type ItemTemplate } from './anchors';
import { RESERVE_V1 } from './reserve';
import { FACET_GROUPS, ONTOLOGY_V1 } from './v1';

export { ANCHOR_SETS, ANCHORS_V1, FACET_GROUPS, type ItemTemplate, ONTOLOGY_V1, RESERVE_V1 };

export const ONTOLOGIES: Record<string, Facet[]> = { v1: ONTOLOGY_V1 };

export function getOntology(version: string): Facet[] {
  const o = ONTOLOGIES[version];
  if (!o) throw new Error(`Unknown ontology version: ${version}`);
  return o;
}

export function getAnchorSet(setId: string): ItemTemplate[] {
  const a = ANCHOR_SETS[setId];
  if (!a) throw new Error(`Unknown anchor set: ${setId}`);
  return a;
}
