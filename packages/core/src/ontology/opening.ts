import type { ItemTemplate } from './anchors';
import { RESERVE_V2 } from './reserve';

/**
 * anchors.e9.v1 (ADR-0073): an opening planned from E9 (ADR-0071), asked in this order (`anchors.order: 'fixed'`). E9
 * found that what carries information about a person's decisions, across Twin-2K-500's train people and in Jev's own
 * reading, is how they handle money and possessions and, once consented, their politics and finances; production's
 * Big Five markers and gambles carry little. These are the reserve bank's direct questions closest to those, so their
 * wording is the reviewed reserve wording. None touches E7's shared-probe facets, so the probes compare arms fairly.
 * The two sensitive ones come after six others, and the session's trust ramp holds them back in any case.
 */
export const ANCHORS_E9_V1_KEYS = [
  'reserve.v2/materialism_1',
  'reserve.v1/windfall',
  'reserve.v2/mental_accounting_2',
  'reserve.v1/gut_call',
  'reserve.v1/big_purchase',
  'reserve.v2/mental_accounting_1',
  'reserve.v2/political_leaning_1',
  'reserve.v2/financial_security_1',
] as const;

export const ANCHORS_E9_V1: ItemTemplate[] = ANCHORS_E9_V1_KEYS.map((key) => {
  const item = RESERVE_V2.find((r) => r.itemKey === key);
  if (!item) throw new Error(`anchors.e9.v1: no reserve.v2 item ${key}`);
  return item;
});
