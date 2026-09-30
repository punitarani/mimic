import type { PipelineConfig } from '../config';
import {
  buildPersona,
  EMPTY_CURATION,
  PERSONA_MIN_ANSWERS,
  PERSONA_PROMPT_VERSION,
  type PersonaSave,
  type PersonaSource,
  type PersonaView,
  pruneCuration,
  writePersonaDraft,
} from '../persona';
import {
  type PersonaCurationRecord as CurationRecord,
  type MimicRecord,
  type PersonaDraftRecord,
  StaleEvidenceError,
} from '../store';
import type { Facet } from '../types';
import { mimicDocParts } from './artifact';
import { loadMimicData } from './data';
import { ctxFor, type EngineDeps, EngineError, facetsFor, loadConfig, requireMimic } from './deps';

/**
 * Persona.md (ADR-0033). Views are built from the mimic's current data rather than a snapshot: viewing never writes a
 * snapshot (so it can't race the `snapshot.write` job or freeze derived data mid-learning), and a fact the person
 * removes leaves the file at once.
 */
async function personaSource(deps: EngineDeps, m: MimicRecord): Promise<PersonaSource> {
  const [loaded, facts, fid] = await Promise.all([
    loadMimicData(deps, m),
    deps.store.listFacts(m.id),
    deps.store.listFidelity(m.id),
  ]);
  const { seqUpTo: _seq, ...parts } = mimicDocParts(m, loaded, facts, fid);
  const removedFacts = facts
    .filter((f) => f.userState === 'removed')
    .map((f) => ({ predicate: f.predicate, object: f.object }));
  // The same fact can be stored twice (search and reflection both add it); removing one removes it from the file.
  const removed = new Set(removedFacts.map((f) => `${f.predicate}|${f.object}`));
  return {
    asOf: deps.clock(),
    ...parts,
    facts: parts.facts.filter((f) => !removed.has(`${f.predicate}|${f.object}`)),
    removedFacts,
  };
}

interface Loaded {
  cfg: PipelineConfig;
  source: PersonaSource;
  facets: Facet[];
}

async function load(deps: EngineDeps, m: MimicRecord): Promise<Loaded> {
  const cfg = await loadConfig(deps, m.configHash);
  const [source, facets] = await Promise.all([personaSource(deps, m), facetsFor(deps, m, cfg)]);
  return { cfg, source, facets };
}

async function view(
  deps: EngineDeps,
  m: MimicRecord,
  pre: { loaded?: Loaded; draft?: PersonaDraftRecord | null; stored?: CurationRecord | null } = {},
): Promise<PersonaView> {
  const [loaded, draft, stored] = await Promise.all([
    pre.loaded ?? load(deps, m),
    pre.draft !== undefined ? pre.draft : deps.store.latestPersonaDraft(m.id),
    pre.stored !== undefined ? pre.stored : deps.store.getPersonaCuration(m.id),
  ]);
  return buildPersona({
    source: loaded.source,
    facets: loaded.facets,
    draft,
    curation: stored?.curation ?? EMPTY_CURATION,
    rev: stored?.rev ?? 0,
  });
}

export async function getPersona(deps: EngineDeps, mimicId: string): Promise<PersonaView> {
  return view(deps, await requireMimic(deps, mimicId));
}

/**
 * Saves the person's choices, then renders them. Edits and hidden keys for draft items a rewrite replaced are dropped;
 * everything else is kept (PLAN §8.3). The save doesn't depend on rendering, so it can't be lost to a render error. A
 * save older than the stored one (by `rev`) is ignored, and the view shows the newer stored curation.
 */
export async function curatePersona(
  deps: EngineDeps,
  mimicId: string,
  save: PersonaSave,
): Promise<PersonaView> {
  const m = await requireMimic(deps, mimicId);
  const draft = await deps.store.latestPersonaDraft(m.id);
  const rec: CurationRecord = {
    mimicId: m.id,
    curation: pruneCuration(save.curation, draft?.draft ?? null),
    rev: save.rev,
    updatedAt: deps.clock(),
  };
  const wrote = await deps.store.putPersonaCuration(rec);
  return view(deps, m, wrote ? { draft, stored: rec } : { draft });
}

/**
 * Writes a new `persona.v1` draft from the mimic's current data. One LLM call through the gateway (logged,
 * budget-guarded). The draft is derived data: it records the evidence, config, prompt and model snapshot it came from
 * (PLAN §3.4).
 */
export async function draftPersona(deps: EngineDeps, mimicId: string): Promise<PersonaView> {
  const m = await requireMimic(deps, mimicId);
  const loaded = await load(deps, m);
  if (m.spendUsd >= loaded.cfg.session.budgetUsd) throw new EngineError('budget', 'Budget reached');
  if (loaded.source.evidence.length < PERSONA_MIN_ANSWERS)
    throw new EngineError('invalid', `Answer at least ${PERSONA_MIN_ANSWERS} questions first.`);
  const model = loaded.cfg.reflector.model ?? loaded.cfg.generator.model;
  const write = () =>
    writePersonaDraft(deps.gateway, ctxFor(m, 'persona.draft'), {
      model,
      source: loaded.source,
      facets: loaded.facets,
    });
  // A model occasionally returns a summary with no usable statement; one retry beats a failed click.
  let { draft, modelSnapshot } = await write();
  if (!draft.statements.length) ({ draft, modelSnapshot } = await write());
  if (!draft.statements.length)
    throw new EngineError('conflict', 'Could not write a persona from these answers. Try again.');
  const rec: PersonaDraftRecord = {
    id: deps.newId(),
    mimicId: m.id,
    seqUpTo: loaded.source.evidence.reduce((a, e) => Math.max(a, e.seq), 0),
    configHash: m.configHash,
    promptVersion: PERSONA_PROMPT_VERSION,
    model,
    modelSnapshot,
    draft,
    createdAt: deps.clock(),
  };
  // Drafted from the answers read above: refused if one of them was undone meanwhile (ADR-0034).
  try {
    await deps.store.guarded(m.id, m.evidenceEpoch).insertPersonaDraft(rec);
  } catch (e) {
    if (e instanceof StaleEvidenceError)
      throw new EngineError('conflict', 'Your answers changed while this was written. Try again.');
    throw e;
  }
  return view(deps, m, { loaded, draft: rec });
}

/** The file itself, as downloaded: `Persona.md`. */
export async function exportPersona(deps: EngineDeps, mimicId: string): Promise<string> {
  return (await getPersona(deps, mimicId)).markdown;
}
