import {
  answerToDistribution,
  argmax,
  buildSoul,
  buildState,
  EMPTY_CURATION,
  type EngineDeps,
  type EvalRunRecord,
  type EvidenceItem,
  type EvidencePolicy,
  facetsFor,
  type Gateway,
  INCUMBENT_COMPONENTS,
  INCUMBENT_HARNESS,
  isPredictedKind,
  isScoredKind,
  keyedByLabel,
  type LoadedMimic,
  loadConfig,
  loadMimicData,
  loadMimicDataAt,
  type MimicDocParts,
  type MimicRecord,
  makePredictor,
  mimicDocParts,
  normalizeDist,
  optionKeys,
  PROMPTS,
  type PredictionResult,
  type PredictorMetrics,
  parseJsonLoose,
  parsePredictorId,
  predictionQuestion,
  predictorMetrics,
  probsSchema,
  type Question,
  type QuestionRecord,
  renderStateText,
  type ScoredRow,
  type SoulDraftRecord,
  type SoulSource,
  scorePrediction,
  seededRng,
  shuffle,
  stateOptions,
  surpriseOf,
  ulid,
  writeSoulDraft,
} from '@mimic/core';
import { HELDOUT_PREFIX } from './replay';

/**
 * Transfer-loss eval (ADR-0055): how much of a mimic survives being exported. For each person and checkpoint k, every
 * export view is rendered from the first k answers alone, a reader that knows nothing about Mimic predicts the later
 * answers from that view and nothing else, and the scores are set against the full in-context state the mimic itself
 * uses. The loss per view, at its size in tokens, is what an agent elsewhere gives up for reading the file.
 *
 * Views are sealed by construction (every one is built from evidence with seq < beforeSeq and derived data as of the
 * serve time, exactly as replay builds states), and the run refuses to continue if a rendered view mentions a later
 * question or reason: the eval checks its own sealing.
 */

export const TRANSFER_VIEWS = ['context', 'state', 'card', 'soul-core', 'soul-full', 'mimic-json'] as const;
export type TransferView = (typeof TRANSFER_VIEWS)[number];

export interface TransferSpec {
  name: string;
  /** Reader predictor IDs: `llm:<model>` reads the view with `transfer.v1`; `jev:<model>` gets it as a text state. */
  readers: string[];
  views: TransferView[];
  checkpoints: number[];
  split: 'dev' | 'test' | 'all';
  targets: 'later' | 'heldout';
  /** Write a sealed `soul.v1` draft per person and checkpoint (one LLM call each); else use a stored sealed draft. */
  draft: boolean;
  /** The card view's cap and policy (ADR-0054). */
  cardMaxEvidence: number;
  cardPolicy: EvidencePolicy;
  limitPeople?: number;
  seed: string;
}

export interface ViewMetrics extends PredictorMetrics {
  view: TransferView;
  reader: string;
  /** Mean size of the rendered view, in tokens (4 characters each). */
  tokens: number;
  /** Accuracy of the `state` view with the same reader minus this view's: what the export costs (null for `state`). */
  transferLoss: number | null;
}

export interface TransferCheckpoint {
  k: number;
  people: number;
  views: ViewMetrics[];
}

export interface TransferResult {
  run: EvalRunRecord;
  checkpoints: TransferCheckpoint[];
  costUsd: number;
  draftsWritten: number;
  /** Rendered views for the first person at the first checkpoint, so a report can show what the reader saw. */
  samples: Partial<Record<TransferView, string>>;
}

/** Rows are keyed by reader and view; `predictorMetrics` splits its keys on `|`, so the separator is something else. */
const VIEW_SEP = ' » ';
export const viewPredictorId = (reader: string, view: TransferView) => `${reader}${VIEW_SEP}${view}`;

/** Tokens as every size in Mimic is estimated: four characters each. */
export const viewTokens = (text: string) => Math.ceil(text.length / 4);

/** A reader that predicts from a rendered view: a plain LLM with `transfer.v1`, or Jev given the view as its state. */
export interface ViewReader {
  readonly id: string;
  predict(view: string, qs: Question[]): Promise<PredictionResult[]>;
}

const CHUNK = 40;

class LlmViewReader implements ViewReader {
  readonly id: string;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly purpose: string,
  ) {
    this.id = `llm:${model}`;
  }

  predict(view: string, qs: Question[]): Promise<PredictionResult[]> {
    return Promise.all(qs.map((q) => this.one(view, q)));
  }

  private async one(view: string, q: Question): Promise<PredictionResult> {
    const p = PROMPTS['transfer.v1'];
    const keys = optionKeys(q);
    try {
      const res = await this.gateway.chat(
        { purpose: this.purpose },
        {
          model: this.model,
          messages: [
            { role: 'system', content: p.system },
            {
              role: 'user',
              content: `FILE:\n${view}\n\nQUESTION: ${q.prompt}\nOPTIONS:\n${q.options.map((o) => `${o.key}: ${o.label}`).join('\n')}`,
            },
          ],
          jsonSchema: { name: 'probs', schema: probsSchema({ schema: 'probs', keyEnum: true }, keys) },
          reasoningEffort: 'low',
          maxTokens: INCUMBENT_HARNESS.maxTokens,
        },
      );
      const base = { costUsd: res.usage.costUsd, latencyMs: res.latencyMs, modelSnapshot: res.modelSnapshot };
      const parsed = parseJsonLoose(res.content) as { probs?: Array<{ key: string; p: number }> } | undefined;
      if (!parsed?.probs || !Array.isArray(parsed.probs))
        return { ...base, dist: {}, ok: false, error: 'invalid JSON output', errorKind: 'output' };
      const raw = keyedByLabel(Object.fromEntries(parsed.probs.map((x) => [x.key, x.p])), q);
      const covered = keys.filter((k) => typeof raw[k] === 'number' && raw[k]! >= 0);
      if (covered.length < keys.length || !(covered.reduce((a, k) => a + raw[k]!, 0) > 0))
        return {
          ...base,
          dist: {},
          ok: false,
          error: 'output does not cover every option',
          errorKind: 'output',
        };
      return { ...base, dist: normalizeDist(raw, keys), ok: true };
    } catch (e) {
      return {
        dist: {},
        costUsd: 0,
        latencyMs: 0,
        modelSnapshot: this.model,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorKind: 'transport',
      };
    }
  }
}

class JevViewReader implements ViewReader {
  readonly id: string;
  constructor(
    private readonly gateway: Gateway,
    private readonly model: string,
    private readonly purpose: string,
  ) {
    this.id = `jev:${model}`;
  }

  async predict(view: string, qs: Question[]): Promise<PredictionResult[]> {
    const out: PredictionResult[] = [];
    for (let i = 0; i < qs.length; i += CHUNK) {
      const batch = qs.slice(i, i + CHUNK);
      // The incumbent templates, with the file as the whole state: the decision model reads it as it is.
      const questions = Object.fromEntries(
        batch.map((q) => [`q_${q.id}`, predictionQuestion(q, INCUMBENT_COMPONENTS)]),
      );
      try {
        const res = await this.gateway.decide(
          { purpose: this.purpose },
          { model: this.model, state: { person_model: view }, questions },
        );
        const share = res.usage.costUsd / batch.length;
        const base = { costUsd: share, latencyMs: res.latencyMs, modelSnapshot: res.modelSnapshot };
        for (const q of batch) {
          const a = res.answers[`q_${q.id}`];
          if (!a) {
            out.push({ ...base, dist: {}, ok: false, error: 'missing answer', errorKind: 'output' });
            continue;
          }
          try {
            out.push({ ...base, dist: answerToDistribution(q, a), ok: true });
          } catch (e) {
            out.push({ ...base, dist: {}, ok: false, error: String(e), errorKind: 'output' });
          }
        }
      } catch (e) {
        for (const _q of batch)
          out.push({
            dist: {},
            costUsd: 0,
            latencyMs: 0,
            modelSnapshot: this.model,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            errorKind: 'transport',
          });
      }
    }
    return out;
  }
}

export function makeViewReader(gateway: Gateway, id: string, purpose: string): ViewReader {
  const spec = parsePredictorId(id);
  if (spec.promptVersion) throw new Error(`A reader takes no prompt version (${id}): it reads only the file`);
  return spec.kind === 'llm'
    ? new LlmViewReader(gateway, spec.model, purpose)
    : new JevViewReader(gateway, spec.model, purpose);
}

/**
 * The person's data as `mimic.json` would hold it at the checkpoint: answers with seq < beforeSeq that are in the
 * training set, traits and insights sealed below it, facts written by then. Feedback given before the checkpoint
 * stays in, as it did online (ADR-0032).
 */
function sealedParts(
  m: MimicRecord,
  loaded: LoadedMimic,
  beforeSeq: number,
  trainSeqs: Set<number>,
  withSurprise: (e: EvidenceItem) => EvidenceItem,
): { parts: MimicDocParts; data: LoadedMimic['data']; facts: LoadedMimic['facts'] } {
  const keep = (seq: number, kind: EvidenceItem['kind']) =>
    trainSeqs.has(seq) || (kind === 'feedback' && seq < beforeSeq);
  const kindOf = new Map(loaded.questions.map((q) => [q.id, q.kind]));
  const data = {
    ...loaded.data,
    evidence: loaded.data.evidence.filter((e) => keep(e.seq, e.kind)).map(withSurprise),
    traits: loaded.data.traits.filter((t) => t.seqUpTo < beforeSeq),
    insights: loaded.data.insights.filter(
      (i) => i.seqUpTo < beforeSeq && i.evidenceSeqs.length > 0 && i.evidenceSeqs.every((s) => s < beforeSeq),
    ),
  };
  const facts = loaded.facts.filter(
    (f) => f.seqUpTo === undefined || f.seqUpTo === null || f.seqUpTo < beforeSeq,
  );
  const sealed: LoadedMimic = {
    ...loaded,
    data,
    facts,
    answers: loaded.answers.filter((a) => keep(a.seq, kindOf.get(a.questionId) ?? 'adaptive')),
  };
  return { parts: mimicDocParts(m, sealed, facts, []), data, facts };
}

function soulSource(parts: MimicDocParts, asOf: number, fidelity: SoulSource['fidelity']): SoulSource {
  const { seqUpTo: _seq, fidelity: _f, ...rest } = parts;
  return { asOf, ...rest, fidelity, removedFacts: [] };
}

/** The questions a sealed view must not mention: those answered at or after the checkpoint, with their reasons. */
function laterTexts(loaded: LoadedMimic, beforeSeq: number): string[] {
  const earlier = new Set(
    loaded.questions.filter((q) => q.seq !== null && q.seq < beforeSeq).map((q) => q.prompt),
  );
  const out: string[] = [];
  for (const q of loaded.questions) {
    if (q.seq === null || q.seq < beforeSeq || earlier.has(q.prompt)) continue;
    out.push(q.prompt);
    const a = loaded.answers.find((x) => x.questionId === q.id);
    if (a?.why && a.why.length >= 12) out.push(a.why);
  }
  return out;
}

export async function transfer(
  deps: EngineDeps,
  spec: TransferSpec,
  datasetHash: string,
): Promise<TransferResult> {
  const all = await deps.store.listMimics({ consentResearch: true });
  let mimics = all.filter((m) => spec.split === 'all' || m.split === spec.split);
  mimics = shuffle(mimics, seededRng(spec.seed)).slice(0, spec.limitPeople ?? mimics.length);
  const readers = spec.readers.map((id) => makeViewReader(deps.gateway, id, 'eval.transfer'));
  const rowsByK = new Map<number, ScoredRow[]>();
  const failuresByK = new Map<number, Array<{ predictorId: string; role: string }>>();
  const tokensByK = new Map<number, Map<TransferView, number[]>>();
  const peopleByK = new Map<number, Set<string>>();
  const samples: Partial<Record<TransferView, string>> = {};
  let cost = 0;
  let draftsWritten = 0;

  for (const m of mimics) {
    const cfg = await loadConfig(deps, m.configHash);
    const facets = await facetsFor(deps, m, cfg);
    const loaded = await loadMimicData(deps, m, { scores: true });
    const qById = new Map(loaded.questions.map((q) => [q.id, q]));
    const answerByQ = new Map(loaded.answers.map((a) => [a.questionId, a]));
    const items = loaded.data.evidence.filter((e) => isScoredKind(e.kind)).sort((a, b) => a.seq - b.seq);
    const isHeldout = (qid: string) => qById.get(qid)?.itemKey?.startsWith(HELDOUT_PREFIX) ?? false;
    const train = spec.targets === 'heldout' ? items.filter((e) => !isHeldout(e.questionId)) : items;
    const heldout = items.filter((e) => isHeldout(e.questionId));
    const fid = await deps.store.listFidelity(m.id);
    const storedDraft = await deps.store.latestSoulDraft(m.id);

    // The card ranks answers by the baseline's surprise (ADR-0054): stored online, computed here for an import.
    const surpriseBySeq = new Map<number, number>();
    if (spec.views.includes('card') && spec.cardPolicy === 'surprise') {
      const missing = train.filter((e) => e.surprise === undefined);
      if (missing.length) {
        const baseline = makePredictor(deps.gateway, cfg.predictor.primary, {
          purpose: 'eval.transfer.baseline',
        });
        const baseState = buildState(loaded.data, stateOptions(cfg, 0, { contextOnly: true }));
        const qs = missing.map((e) => qById.get(e.questionId)!);
        for (let i = 0; i < qs.length; i += CHUNK) {
          const batch = qs.slice(i, i + CHUNK);
          const preds = await baseline.predict(baseState, batch);
          preds.forEach((p, j) => {
            if (!p.ok) return;
            const q = batch[j]!;
            const { logLoss } = scorePrediction(q.type, p.dist, answerByQ.get(q.id)!.value);
            surpriseBySeq.set(missing[i + j]!.seq, surpriseOf(logLoss, q.options.length));
            cost += p.costUsd;
          });
        }
      }
    }
    const withSurprise = (e: EvidenceItem): EvidenceItem =>
      e.surprise === undefined && surpriseBySeq.has(e.seq)
        ? { ...e, surprise: surpriseBySeq.get(e.seq)! }
        : e;

    for (const k of spec.checkpoints) {
      if (k > train.length) continue;
      const targets = spec.targets === 'heldout' ? heldout : items.slice(k);
      if (!targets.length) continue;
      const beforeSeq = train[k - 1]!.seq + 1;
      const trainSeqs = new Set(train.slice(0, k).map((e) => e.seq));
      const next = loaded.questions
        .filter((q) => q.seq !== null && q.seq >= beforeSeq && isPredictedKind(q.kind))
        .sort((a, b) => a.seq! - b.seq!)[0];
      const at = next?.stateAt ?? next?.servedAt ?? Number.MAX_SAFE_INTEGER;
      const asOf = await loadMimicDataAt(deps, m, at, beforeSeq, { scores: true });
      const { parts, data } = sealedParts(m, asOf, beforeSeq, trainSeqs, withSurprise);
      const fidelity = fid.filter((f) => f.seqUpTo < beforeSeq).at(-1);
      const source = soulSource(
        parts,
        Math.min(at, deps.clock()),
        fidelity
          ? {
              fidelity: fidelity.fidelity,
              ci: [fidelity.ciLow, fidelity.ciHigh],
              acc: fidelity.acc,
              accBaseline: fidelity.accBaseline,
              selfConsistency: fidelity.selfConsistency,
              n: fidelity.nScored,
            }
          : null,
      );

      // A draft sealed below the checkpoint: written now, or the stored one if it is old enough.
      let draft: (SoulDraftRecord & { draft: SoulDraftRecord['draft'] }) | null = null;
      if (spec.views.some((v) => v.startsWith('soul'))) {
        if (spec.draft && source.evidence.length >= 5) {
          const model = cfg.reflector.model ?? cfg.generator.model;
          const r = await writeSoulDraft(
            deps.gateway,
            { purpose: 'eval.transfer.draft', mimicId: m.id },
            {
              model,
              source,
              facets,
            },
          );
          draftsWritten++;
          draft = {
            id: ulid(),
            mimicId: m.id,
            seqUpTo: beforeSeq - 1,
            configHash: m.configHash,
            promptVersion: 'soul.v1',
            model,
            modelSnapshot: r.modelSnapshot,
            draft: r.draft,
            createdAt: deps.clock(),
          };
        } else if (storedDraft && storedDraft.seqUpTo < beforeSeq) draft = storedDraft;
      }

      const views = new Map<TransferView, string>();
      for (const v of spec.views) {
        if (v === 'context')
          views.set(v, renderStateText(buildState(data, stateOptions(cfg, 0, { contextOnly: true }))));
        else if (v === 'state')
          views.set(v, renderStateText(buildState(data, stateOptions(cfg, beforeSeq, { strategy: 'full' }))));
        else if (v === 'card')
          views.set(
            v,
            renderStateText(
              buildState(
                data,
                stateOptions(cfg, beforeSeq, {
                  strategy: 'card',
                  evidencePolicy: spec.cardPolicy,
                  maxEvidence: spec.cardMaxEvidence,
                }),
              ),
            ),
          );
        else if (v === 'soul-core' || v === 'soul-full')
          views.set(
            v,
            buildSoul(
              { source, facets, draft, curation: EMPTY_CURATION },
              v === 'soul-core' ? 'core' : 'full',
            ).markdown,
          );
        else if (v === 'mimic-json')
          views.set(
            v,
            JSON.stringify(
              {
                schema: 'mimic/1',
                subject: parts.subject,
                facts: parts.facts,
                evidence: parts.evidence,
                traits: parts.traits,
                insights: parts.insights,
                fidelity: source.fidelity,
              },
              null,
              1,
            ),
          );
      }

      // The eval checks its own sealing: a view that mentions a later question or reason stops the run.
      const later = laterTexts(loaded, beforeSeq);
      for (const [v, text] of views) {
        const leak = later.find((t) => text.includes(t));
        if (leak)
          throw new Error(
            `Sealing violated: view ${v} at k=${k} for ${m.id} mentions "${leak.slice(0, 60)}"`,
          );
      }
      if (!Object.keys(samples).length) for (const [v, text] of views) samples[v] = text;

      const qs = targets.map((e) => qById.get(e.questionId)!) as QuestionRecord[];
      const rows = rowsByK.get(k) ?? [];
      const failures = failuresByK.get(k) ?? [];
      const tokens = tokensByK.get(k) ?? new Map<TransferView, number[]>();
      for (const [v, text] of views) tokens.set(v, [...(tokens.get(v) ?? []), viewTokens(text)]);
      for (const reader of readers) {
        for (const [v, text] of views) {
          const preds = await reader.predict(text, qs);
          qs.forEach((q, i) => {
            const p = preds[i]!;
            const predictorId = viewPredictorId(reader.id, v);
            const role = v === 'context' ? 'baseline' : 'primary';
            if (!p.ok) {
              failures.push({ predictorId, role });
              return;
            }
            cost += p.costUsd;
            const s = scorePrediction(q.type, p.dist, answerByQ.get(q.id)!.value);
            rows.push({
              mimicId: m.id,
              questionId: `${q.id}@${k}`,
              predictorId,
              role,
              itemAcc: s.itemAcc,
              top1: s.top1,
              logLoss: s.logLoss,
              brier: s.brier,
              confidence: p.dist[argmax(p.dist)] ?? 0,
              costUsd: p.costUsd,
              latencyMs: p.latencyMs,
            });
          });
        }
      }
      rowsByK.set(k, rows);
      failuresByK.set(k, failures);
      tokensByK.set(k, tokens);
      peopleByK.set(k, new Set([...(peopleByK.get(k) ?? []), m.id]));
    }
  }

  const checkpoints: TransferCheckpoint[] = spec.checkpoints
    .filter((k) => rowsByK.has(k))
    .map((k) => {
      const rows = rowsByK.get(k) ?? [];
      const failures = failuresByK.get(k) ?? [];
      const tokens = tokensByK.get(k) ?? new Map<TransferView, number[]>();
      const views: ViewMetrics[] = [];
      for (const reader of readers) {
        // Lift pairs each view with the `context` view of the same reader, so metrics are computed per reader.
        const mine = rows.filter((r) => r.predictorId.startsWith(`${reader.id}${VIEW_SEP}`));
        const metrics = predictorMetrics(
          mine,
          failures.filter((f) => f.predictorId.startsWith(`${reader.id}${VIEW_SEP}`)),
        );
        const stateAcc =
          metrics.find((p) => p.predictorId === viewPredictorId(reader.id, 'state'))?.accuracy ?? null;
        for (const p of metrics) {
          const view = p.predictorId.slice(reader.id.length + VIEW_SEP.length) as TransferView;
          const sizes = tokens.get(view) ?? [];
          views.push({
            ...p,
            view,
            reader: reader.id,
            tokens: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
            transferLoss: view === 'state' || stateAcc === null ? null : stateAcc - p.accuracy,
          });
        }
      }
      views.sort(
        (a, b) =>
          a.reader.localeCompare(b.reader) || TRANSFER_VIEWS.indexOf(a.view) - TRANSFER_VIEWS.indexOf(b.view),
      );
      return { k, people: peopleByK.get(k)?.size ?? 0, views };
    });

  const run: EvalRunRecord = {
    id: ulid(),
    name: spec.name,
    spec: { ...spec, kind: 'transfer' },
    datasetHash,
    status: 'done',
    metrics: { checkpoints, costUsd: cost, people: mimics.length, draftsWritten, samples },
    r2ReportKey: null,
    createdAt: deps.clock(),
  };
  await deps.store.putEvalRun(run);
  return { run, checkpoints, costUsd: cost, draftsWritten, samples };
}

/** Markdown for a transfer run (`renderReport`). */
export function renderTransfer(m: Record<string, unknown>): string[] {
  const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
  const f3 = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
  const pts = (x: unknown) => (typeof x === 'number' ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '—');
  const lines = [
    `People: ${String(m.people)} · cost: $${Number(m.costUsd ?? 0).toFixed(4)} · drafts written: ${String(m.draftsWritten ?? 0)}`,
    '',
    "Transfer loss is the `state` view's accuracy with the same reader minus the view's: what reading the export instead of",
    'the live state costs. Lift is against the `context` view (identity only) with the same reader.',
    '',
  ];
  for (const c of (m.checkpoints as TransferCheckpoint[]) ?? []) {
    lines.push(
      `## After ${c.k} answers (${c.people} people)`,
      '',
      '| Reader | View | Tokens | n | Accuracy | Top-1 | Log loss | Brier | ECE | Lift | Transfer loss | Failed | $/1k | p50 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...c.views.map(
        (v) =>
          `| \`${v.reader}\` | ${v.view} | ${v.tokens} | ${v.n} | ${pct(v.accuracy)} | ${pct(v.top1)} | ${f3(v.logLoss)} | ${f3(v.brier)} | ${f3(v.ece)} | ${pts(v.lift)} | ${pts(v.transferLoss)} | ${pct(v.failureRate)} | $${v.usdPer1k.toFixed(3)} | ${Math.round(v.p50LatencyMs)} ms |`,
      ),
      '',
    );
  }
  return lines;
}
