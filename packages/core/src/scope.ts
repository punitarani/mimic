import { z } from 'zod';
import {
  CATEGORIES,
  Category,
  type Facet,
  isSpecialArea,
  SENSITIVE_AREAS,
  type SensitiveArea,
  SPECIAL_AREAS,
  type SpecialArea,
} from './types';

/**
 * What a mimic may be asked about and learn (docs/CATEGORIES.md, ADR-0040): the categories the person selected, the
 * sensitive areas they consented to, and the special-category areas they allow in research exports. Pure and
 * client-safe (only zod), so the intake form, the session sheet and the engine share one definition.
 */

const AreaFlags = z.object({
  politics: z.boolean().optional(),
  religion: z.boolean().optional(),
  sexuality: z.boolean().optional(),
  health: z.boolean().optional(),
  money: z.boolean().optional(),
});
const SpecialFlags = z.object({
  politics: z.boolean().optional(),
  religion: z.boolean().optional(),
  sexuality: z.boolean().optional(),
  health: z.boolean().optional(),
});

/** Re-exported so client code can import everything about scope from `@mimic/core/scope` alone. */
export {
  CATEGORIES,
  Category,
  isSpecialArea,
  SENSITIVE_AREAS,
  SensitiveArea,
  SPECIAL_AREAS,
  SpecialArea,
} from './types';

export const MimicScope = z.object({
  categories: z.array(Category).min(1).max(CATEGORIES.length),
  /** Consent to be asked about each sensitive area. Absent means no. */
  consents: AreaFlags.default({}),
  /** Consent to research use of each special-category area (only with research consent overall). Absent means no. */
  researchConsents: SpecialFlags.default({}),
  /**
   * Special-category areas the person affirmatively chose (ADR-0050): ticked at intake or in Topics and consent, or
   * confirmed in the session. A consent left at intake's pre-ticked default is stored but not confirmed, and its
   * facets stay out of reach until it is. Absent means none confirmed.
   */
  confirmed: SpecialFlags.optional(),
  /** Sensitive facets the person chose not to answer ("Prefer not to say", ADR-0050). Never asked again. */
  declined: z.array(z.string().min(1).max(64)).max(200).optional(),
});
export type MimicScope = z.infer<typeof MimicScope>;

/** Every category, no sensitive area: what an API call without a scope and mimics created before ADR-0040 read as. */
export const DEFAULT_SCOPE: MimicScope = { categories: [...CATEGORIES], consents: {}, researchConsents: {} };

/**
 * What the intake form starts from (ADR-0049): every category and every sensitive area ticked, so the person turns off
 * what they'd rather not share. Research use of special-category answers comes with the research box, which starts
 * unticked (`withResearchUse`, ADR-0067).
 */
export const INTAKE_SCOPE: MimicScope = {
  categories: [...CATEGORIES],
  // Spelled out so a new area fails to compile here until someone decides whether intake ticks it.
  consents: {
    politics: true,
    religion: true,
    sexuality: true,
    health: true,
    money: true,
  } satisfies Record<SensitiveArea, true>,
  researchConsents: {},
};

export interface CategoryInfo {
  name: string;
  description: string;
  /** Sensitive areas asked about under this category, each behind its own consent. */
  areas: SensitiveArea[];
}

/** Intake and session copy (sentence case, one line each). docs/CATEGORIES.md quotes it. */
export const CATEGORY_INFO: Record<Category, CategoryInfo> = {
  psychology: {
    name: 'Personality and psychology',
    description: 'How you think, feel and decide: habits, emotions, motivation and self-control.',
    areas: [],
  },
  values: {
    name: 'Values, beliefs and politics',
    description: 'What you care about and believe: fairness, loyalty and how the world works.',
    areas: ['politics', 'religion'],
  },
  life: {
    name: 'Relationships, sexuality and life',
    description: 'Friends, partners, family and everyday life.',
    areas: ['sexuality', 'health'],
  },
  work: {
    name: 'Work and money',
    description: 'How you work, decide with others, spend and save.',
    areas: ['money'],
  },
};

export interface AreaInfo {
  name: string;
  /** Why we ask, in one line. */
  why: string;
  category: Category;
  /** Special-category data: research use is recorded per area (`researchConsents`, ADR-0067). */
  special: boolean;
}

export const AREA_INFO: Record<SensitiveArea, AreaInfo> = {
  politics: {
    name: 'Political views',
    why: 'Where you stand politically shapes many everyday choices, so asking beats guessing.',
    category: 'values',
    special: true,
  },
  religion: {
    name: 'Religion and worldview',
    why: 'Faith, or its absence, shapes values and routines; we only learn it if you answer.',
    category: 'values',
    special: true,
  },
  sexuality: {
    name: 'Sexuality and intimate relationships',
    why: 'How you approach intimacy and commitment shapes many relationship decisions.',
    category: 'life',
    special: true,
  },
  health: {
    name: 'Health and body',
    why: 'How you look after your health and body affects daily choices about food, rest and risk.',
    category: 'life',
    special: true,
  },
  money: {
    name: 'Money in detail',
    why: 'Savings, debt and financial security change how people weigh risk and spending.',
    category: 'work',
    special: false,
  },
};

/** Shown with every sensitive consent. */
export const SELF_ONLY_NOTE = 'Your answers stay yours: they are only used to build your mimic.';

/**
 * The stored form: categories in canonical order, only `true` flags kept, consents dropped for deselected categories,
 * research consents kept only with the area's consent and research consent overall. Deselecting a category therefore
 * forgets its consents: reselecting it asks again. Confirmations are kept only for consented special areas, declined
 * facets de-duplicated; both are left out when empty.
 */
export function normalizeScope(scope: MimicScope, consentResearch: boolean): MimicScope {
  const selected = new Set(scope.categories);
  const categories = CATEGORIES.filter((c) => selected.has(c));
  if (!categories.length) throw new Error('A mimic needs at least one category');
  const consents: MimicScope['consents'] = {};
  for (const a of SENSITIVE_AREAS)
    if (scope.consents[a] === true && selected.has(AREA_INFO[a].category)) consents[a] = true;
  const researchConsents: MimicScope['researchConsents'] = {};
  if (consentResearch)
    for (const a of SPECIAL_AREAS)
      if (scope.researchConsents[a] === true && consents[a]) researchConsents[a] = true;
  const confirmed: NonNullable<MimicScope['confirmed']> = {};
  for (const a of SPECIAL_AREAS) if (scope.confirmed?.[a] === true && consents[a]) confirmed[a] = true;
  const declined = [...new Set(scope.declined ?? [])];
  return {
    categories,
    consents,
    researchConsents,
    ...(Object.keys(confirmed).length ? { confirmed } : {}),
    ...(declined.length ? { declined } : {}),
  };
}

/**
 * Research use follows research consent (ADR-0067): a special-category area the person newly agrees to be asked about
 * joins research use, so at intake (`prev` null) research consent covers every consented area. An area already
 * consented in `prev` keeps the research use stored with it, whatever the request sends: saving never widens a choice
 * made under the per-area boxes that came before, and a form that turned an area off and on again before saving
 * (which clears its research use in the draft) doesn't narrow it either. `normalizeScope` then drops it all without
 * research consent overall.
 */
export function withResearchUse(scope: MimicScope, prev: MimicScope | null): MimicScope {
  const researchConsents: MimicScope['researchConsents'] = {};
  for (const a of SPECIAL_AREAS) {
    if (scope.consents[a] !== true) continue;
    if (prev?.consents[a] !== true || prev.researchConsents[a] === true) researchConsents[a] = true;
  }
  return { ...scope, researchConsents };
}

/** A consented special-category area the person hasn't affirmatively chosen yet (ADR-0050). */
export function unconfirmedAreas(scope: MimicScope): SpecialArea[] {
  return SPECIAL_AREAS.filter((a) => scope.consents[a] === true && scope.confirmed?.[a] !== true);
}

/**
 * A facet is reachable when its category is selected, the person hasn't declined it, and, if sensitive, its area is
 * consented; a special-category area (politics, religion, sexuality, health) must also be confirmed (ADR-0050).
 */
export function facetAllowed(scope: MimicScope, f: Pick<Facet, 'id' | 'category' | 'sensitive'>): boolean {
  if (!scope.categories.includes(f.category)) return false;
  if (scope.declined?.includes(f.id)) return false;
  if (f.sensitive === undefined) return true;
  if (scope.consents[f.sensitive] !== true) return false;
  return !isSpecialArea(f.sensitive) || scope.confirmed?.[f.sensitive] === true;
}

export function scopedFacets<F extends Pick<Facet, 'id' | 'category' | 'sensitive'>>(
  scope: MimicScope,
  facets: F[],
): F[] {
  return facets.filter((f) => facetAllowed(scope, f));
}

export function blockedFacetIds(
  scope: MimicScope,
  facets: Array<Pick<Facet, 'id' | 'category' | 'sensitive'>>,
) {
  return new Set(facets.filter((f) => !facetAllowed(scope, f)).map((f) => f.id));
}

/**
 * True when `after` removes something `before` allowed: a category, a sensitive consent or a confirmation. What was
 * learned under the old scope is then hidden (docs/CATEGORIES.md). Research-consent changes don't count: they only
 * affect exports. Newly declined facets are reported separately (`newlyDeclined`).
 */
export function scopeShrank(before: MimicScope, after: MimicScope): boolean {
  if (before.categories.some((c) => !after.categories.includes(c))) return true;
  if (SENSITIVE_AREAS.some((a) => before.consents[a] === true && after.consents[a] !== true)) return true;
  return SPECIAL_AREAS.some((a) => before.confirmed?.[a] === true && after.confirmed?.[a] !== true);
}

/** Facets `after` declines that `before` didn't. */
export function newlyDeclined(before: MimicScope, after: MimicScope): string[] {
  const had = new Set(before.declined ?? []);
  return (after.declined ?? []).filter((f) => !had.has(f));
}

/** A question is out of scope when any facet it touches is blocked. Unknown facet ids (twin imports) are not. */
export function questionAllowed(q: { facetIds: readonly string[] }, blocked: ReadonlySet<string>): boolean {
  return !q.facetIds.some((f) => blocked.has(f));
}

export interface ScopeView {
  allowed: Set<string>;
  blocked: Set<string>;
  /** Questions touching a blocked facet: never served, and their answers never enter a state or a view. */
  hiddenQuestionIds: Set<string>;
  hiddenSeqs: Set<number>;
  /** Each allowed sensitive facet → seqs of the questions that asked about it directly. */
  sensitiveSeqs: Map<string, Set<number>>;
  /** Each consented sensitive area → seqs of the questions that asked about one of its facets directly. */
  areaSeqs: Map<SensitiveArea, Set<number>>;
  /** Allowed sensitive facets and their areas. */
  sensitiveFacets: Map<string, SensitiveArea>;
}

export function scopeView(
  scope: MimicScope,
  facets: Array<Pick<Facet, 'id' | 'category' | 'sensitive'>>,
  questions: Array<{ id: string; seq: number | null; facetIds: readonly string[] }>,
): ScopeView {
  const allowed = new Set<string>();
  const blocked = new Set<string>();
  const sensitive = new Map<string, SensitiveArea>();
  for (const f of facets) {
    if (facetAllowed(scope, f)) {
      allowed.add(f.id);
      if (f.sensitive) sensitive.set(f.id, f.sensitive);
    } else blocked.add(f.id);
  }
  const hiddenQuestionIds = new Set<string>();
  const hiddenSeqs = new Set<number>();
  const sensitiveSeqs = new Map<string, Set<number>>();
  const areaSeqs = new Map<SensitiveArea, Set<number>>();
  for (const q of questions) {
    if (!questionAllowed(q, blocked)) {
      hiddenQuestionIds.add(q.id);
      if (q.seq !== null) hiddenSeqs.add(q.seq);
      continue;
    }
    if (q.seq === null) continue;
    for (const f of q.facetIds) {
      const area = sensitive.get(f);
      if (!area) continue;
      const seqs = sensitiveSeqs.get(f) ?? new Set<number>();
      seqs.add(q.seq);
      sensitiveSeqs.set(f, seqs);
      const bySeq = areaSeqs.get(area) ?? new Set<number>();
      bySeq.add(q.seq);
      areaSeqs.set(area, bySeq);
    }
  }
  return {
    allowed,
    blocked,
    hiddenQuestionIds,
    hiddenSeqs,
    sensitiveSeqs,
    areaSeqs,
    sensitiveFacets: sensitive,
  };
}

/** The seqs a reflection fact cites (`source_ref = 'answers:3,5'`), or [] for other sources. */
export function factCitedSeqs(f: { source: string; sourceRef: string | null }): number[] {
  if (f.source !== 'reflection' || !f.sourceRef?.startsWith('answers:')) return [];
  return f.sourceRef
    .slice('answers:'.length)
    .split(',')
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x));
}

/** A reflection fact is hidden when it cites a hidden answer. */
export function factHidden(view: ScopeView, f: { source: string; sourceRef: string | null }): boolean {
  return factCitedSeqs(f).some((s) => view.hiddenSeqs.has(s));
}

/** An insight is hidden when it names a blocked facet or cites a hidden answer. */
export function insightHidden(
  view: ScopeView,
  i: { facetIds: readonly string[]; evidenceSeqs: readonly number[] },
) {
  return i.facetIds.some((f) => view.blocked.has(f)) || i.evidenceSeqs.some((s) => view.hiddenSeqs.has(s));
}

/** Facet ids of one special-category area. */
export function specialFacetIds(
  area: SpecialArea,
  facets: Array<Pick<Facet, 'id' | 'sensitive'>>,
): Set<string> {
  return new Set(facets.filter((f) => f.sensitive === area).map((f) => f.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Special-category facts from web search (ADR-0040): never stored. Enrichment never asks for these fields; this
// lexicon is the backstop for free text (interests, projects, headlines). It errs toward dropping.
// ---------------------------------------------------------------------------------------------------------------

/** Predicates that describe a job or schooling: an employer in health care says nothing about the person's health. */
const PROFESSIONAL_PREDICATES = new Set(['worksAt', 'workedAt', 'jobTitle', 'educatedAt']);

const LEXICON: Array<{ area: SpecialArea; pattern: RegExp; professionalToo: boolean }> = [
  {
    area: 'religion',
    pattern:
      /\b(church|mosque|synagogue|parish|chapel|bible|quran|koran|torah|gospel|christian(ity)?|catholic|protestant|baptist|methodist|lutheran|evangelical|pentecostal|anglican|orthodox church|muslim|islam(ic)?|jewish|judaism|hindu(ism)?|buddhis[mt]|sikh(ism)?|mormon|latter[- ]day saints|jehovah|atheis[mt]|agnostic|pastor|priest|rabbi|imam|clergy|faith[- ]based|religio(n|us)|spiritual(ity)?|worship|prayer|sunday (mass|school)|\bmass\b)\b/i,
    professionalToo: true,
  },
  {
    area: 'politics',
    pattern:
      /\b((democratic|republican|labou?r|conservative|liberal democrat|green|libertarian|socialist|communist|reform) party|political (party|campaign|activis[mt]|organi[sz]er)|campaign (volunteer|staffer)|election campaign|activis[mt]|protester|young (republicans|democrats)|maga|antifa|voted for)\b/i,
    professionalToo: true,
  },
  {
    area: 'health',
    pattern:
      /\b(cancer|diabetes|diabetic|hiv|aids|depression|anxiety disorder|adhd|autism|autistic|bipolar|schizophreni\w*|ptsd|ocd|disabilit(y|ies)|disabled|chronic (illness|pain|fatigue)|eating disorder|anorexia|bulimia|addiction|alcoholi(c|sm)|in recovery|sobriety|sober|therapy|therapist|mental (health|illness)|pregnan\w*|ivf|fertility|transplant|survivor)\b/i,
    professionalToo: false,
  },
  {
    area: 'sexuality',
    pattern:
      /\b(lgbt\w*|gay|lesbian|bisexual|queer|transgender|trans (man|woman)|non[- ]binary|asexual|pansexual|pride (network|group|month|parade)|polyamor\w*|kink\w*|swinger|dating app)\b/i,
    professionalToo: true,
  },
];

/** The special-category area a fact reveals, or null. */
export function specialAreaOfFact(f: { predicate: string; object: string }): SpecialArea | null {
  const professional = PROFESSIONAL_PREDICATES.has(f.predicate);
  for (const { area, pattern, professionalToo } of LEXICON) {
    if (professional && !professionalToo) continue;
    if (pattern.test(f.object)) return area;
  }
  return null;
}

/** Removes sentences that reveal a special-category area from free text (search candidate summaries). */
export function stripSpecialText(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.filter((s) => !LEXICON.some(({ pattern }) => pattern.test(s))).join(' ');
}

/** Every special-category area a free text reveals, by the same lexicon as facts. */
export function specialAreasOfText(text: string): SpecialArea[] {
  return LEXICON.filter(({ pattern }) => pattern.test(text)).map(({ area }) => area);
}

// ---------------------------------------------------------------------------------------------------------------
// Direct evidence only (ADR-0043): what the reflector and the hypothesis writer may say about a sensitive area.
// ---------------------------------------------------------------------------------------------------------------

/** True when one of `cited` answered a question that asked about `area` directly (and the area is consented). */
export function citesDirect(view: ScopeView, area: SensitiveArea, cited: readonly number[]): boolean {
  const seqs = view.areaSeqs.get(area);
  return !!seqs && cited.some((s) => seqs.has(s));
}

/**
 * An insight as it may be kept, or null to drop it. A sensitive facet tag stays only when the insight cites an answer
 * to a question that asked about that facet directly; an insight whose text reveals a special-category area must
 * cite a direct answer in that area. Nothing about politics, religion, sexuality or health is inferred from other
 * answers, whatever the model wrote.
 */
export function guardInsight<T extends { text: string; facetIds: string[]; evidenceSeqs: number[] }>(
  view: ScopeView,
  insight: T,
): T | null {
  if (specialAreasOfText(insight.text).some((a) => !citesDirect(view, a, insight.evidenceSeqs))) return null;
  const facetIds = insight.facetIds.filter((f) => {
    if (view.blocked.has(f)) return false;
    if (!view.sensitiveFacets.has(f)) return true;
    const seqs = view.sensitiveSeqs.get(f);
    return !!seqs && insight.evidenceSeqs.some((s) => seqs.has(s));
  });
  return { ...insight, facetIds };
}

/** A reflection fact revealing a special-category area is kept only when it cites a direct answer in that area. */
export function reflectionFactAllowed(
  view: ScopeView,
  fact: { predicate: string; object: string; evidenceSeqs: readonly number[] },
): boolean {
  const area = specialAreaOfFact(fact);
  return area === null || citesDirect(view, area, fact.evidenceSeqs);
}

/**
 * Hypothesis text without the sentences that reveal a special-category area the person has not answered a direct
 * question about (at or before `seqUpTo`).
 */
export function guardHypothesisText(view: ScopeView, text: string, seqUpTo: number): string {
  const answered = (a: SpecialArea) => [...(view.areaSeqs.get(a) ?? [])].some((s) => s <= seqUpTo);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.filter((s) => specialAreasOfText(s).every(answered)).join(' ');
}

/**
 * Whether research may use a question with these facets (ADR-0043): every facet is inside the person's scope, and a
 * special-category facet also has the person's research consent for its area. Money follows plain research consent.
 * Facet ids the map doesn't know (occupation facets, imported items) pass.
 */
export function researchAllowed(
  scope: MimicScope,
  facetIds: readonly string[],
  facetById: ReadonlyMap<string, Pick<Facet, 'id' | 'category' | 'sensitive'>>,
): boolean {
  return facetIds.every((id) => {
    const f = facetById.get(id);
    if (!f) return true;
    if (!facetAllowed(scope, f)) return false;
    const area = f.sensitive;
    return !area || !isSpecialArea(area) || scope.researchConsents[area] === true;
  });
}

/** Free text without the sentences revealing a special-category area outside `keep`. */
export function stripSpecialAreas(text: string, keep: ReadonlySet<SpecialArea>): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.filter((s) => specialAreasOfText(s).every((a) => keep.has(a))).join(' ');
}
