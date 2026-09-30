import {
  buildPersona,
  EMPTY_CURATION,
  PERSONA_MIN_ANSWERS,
  PERSONA_PROMPT_VERSION,
  PersonaCuration,
  type PersonaView,
  pruneCuration,
  writePersonaDraft,
} from '../persona';
import type { MimicRecord } from '../store';
import { exportMimic } from './artifact';
import { ctxFor, type EngineDeps, EngineError, facetsFor, loadConfig, requireMimic } from './deps';

/**
 * Persona.md (ADR-0027). Every view is built from the latest snapshot (written fresh if evidence moved past it), the
 * latest `persona.v1` draft and the person's curation, so the preview, the download and `mimic.json` agree.
 */
async function view(
  deps: EngineDeps,
  m: MimicRecord,
  curationOverride?: PersonaCuration,
): Promise<PersonaView> {
  const cfg = await loadConfig(deps, m.configHash);
  const [doc, facets, draft, stored] = await Promise.all([
    exportMimic(deps, m.id),
    facetsFor(deps, m, cfg),
    deps.store.latestPersonaDraft(m.id),
    curationOverride ? null : deps.store.getPersonaCuration(m.id),
  ]);
  return buildPersona({
    doc,
    facets,
    draft,
    curation: curationOverride ?? stored?.curation ?? EMPTY_CURATION,
  });
}

export async function getPersona(deps: EngineDeps, mimicId: string): Promise<PersonaView> {
  return view(deps, await requireMimic(deps, mimicId));
}

/** Saves the person's choices, dropping keys that match no current item. */
export async function curatePersona(deps: EngineDeps, mimicId: string, input: unknown): Promise<PersonaView> {
  const m = await requireMimic(deps, mimicId);
  const curation = PersonaCuration.parse(input);
  const v = await view(deps, m, curation);
  const pruned = pruneCuration(curation, v.sections);
  await deps.store.putPersonaCuration({ mimicId: m.id, curation: pruned, updatedAt: deps.clock() });
  return { ...v, curation: pruned };
}

/**
 * Writes a new `persona.v1` draft from the latest snapshot. One LLM call through the gateway (logged, budget-guarded).
 * The draft is derived data: it records the snapshot, config, prompt and model snapshot it came from (PLAN §3.4).
 */
export async function draftPersona(deps: EngineDeps, mimicId: string): Promise<PersonaView> {
  const m = await requireMimic(deps, mimicId);
  const cfg = await loadConfig(deps, m.configHash);
  if (m.spendUsd >= cfg.session.budgetUsd) throw new EngineError('budget', 'Budget reached');
  const [doc, facets] = await Promise.all([exportMimic(deps, m.id), facetsFor(deps, m, cfg)]);
  if (doc.evidence.length < PERSONA_MIN_ANSWERS)
    throw new EngineError('invalid', `Answer at least ${PERSONA_MIN_ANSWERS} questions first.`);
  const model = cfg.reflector.model ?? cfg.generator.model;
  const { draft, modelSnapshot } = await writePersonaDraft(deps.gateway, ctxFor(m, 'persona.draft'), {
    model,
    doc,
    facets,
  });
  if (!draft.statements.length)
    throw new EngineError('conflict', 'Could not write a persona from these answers. Try again.');
  await deps.store.insertPersonaDraft({
    id: deps.newId(),
    mimicId: m.id,
    snapshotVersion: doc.version,
    seqUpTo: doc.seqUpTo,
    configHash: m.configHash,
    promptVersion: PERSONA_PROMPT_VERSION,
    model,
    modelSnapshot,
    draft,
    createdAt: deps.clock(),
  });
  return view(deps, m);
}

/** The file itself, as downloaded: `Persona.md`. */
export async function exportPersona(deps: EngineDeps, mimicId: string): Promise<string> {
  return (await getPersona(deps, mimicId)).markdown;
}
