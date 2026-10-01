import type {
  AnswerResult,
  ExperimentRecord,
  FeedbackResult,
  MimicScope,
  NextResult,
  PlaygroundHistory,
  PlaygroundPrediction,
  PublicQuestion,
  RewindResult,
  ScopeChange,
  SoulSave,
  SoulView,
  UiSnapshot,
} from '@mimic/core';

/** Browser → our route handlers only. Keys stay server-side (PLAN §3.10). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // An edge error page (HTML) rather than our route: report the status instead of a parse error.
    if (res.ok) throw new ApiError(res.status, 'Unexpected response.');
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

export interface IntakeRequest {
  /** Needed only while sign-up is invite-only (`use-invite-code`, ADR-0054). */
  inviteCode?: string;
  name: string;
  location: string;
  occupation?: string;
  employer?: string;
  link?: string;
  attestSelf: true;
  consentSearch: boolean;
  consentResearch: boolean;
  /** Categories and sensitive areas to ask about (ADR-0040); every category and no sensitive area when absent. */
  scope?: MimicScope;
}

export interface IdentityView {
  status: UiSnapshot['mimic']['identityState'];
  candidates: Array<{
    id: string;
    name: string;
    headline: string | null;
    location: string | null;
    url: string;
    source: string;
    provider: string;
    samePerson: number | null;
    /** The profile at a link the person gave. */
    fromLink: boolean;
    /** Only the latest search's candidates are listed: open or confirmed. */
    status: 'proposed' | 'confirmed';
  }>;
  facts: Array<{
    id: string;
    predicate: string;
    object: string;
    source: string;
    sourceUrl: string | null;
    userState: 'active' | 'removed';
  }>;
}

export interface AnswerRequest {
  questionId: string;
  value: string;
  why?: string;
  latencyMs: number;
  idempotencyKey: string;
  /** False when the person turned guesses off (recorded honestly; no reveal is returned). */
  revealShown?: boolean;
}

export interface Draft {
  type: PublicQuestion['type'];
  prompt: string;
  options: PublicQuestion['options'];
}

/** A question the person answers themselves, for the mimic to learn from (ADR-0032). */
export interface FeedbackRequest {
  question: Draft;
  answer: string;
  why?: string;
  idempotencyKey: string;
}

export const api = {
  createMimic: (b: IntakeRequest) => call<{ mimicId: string; identity: boolean }>('POST', '/api/mimics', b),
  inviteRequired: () => call<{ required: boolean }>('GET', '/api/invite'),
  listMimics: () =>
    call<{
      mimics: Array<{
        id: string;
        displayName: string;
        status: string;
        identityState: string;
        createdAt: number;
      }>;
    }>('GET', '/api/mimics'),
  snapshot: (id: string) => call<UiSnapshot>('GET', `/api/mimics/${id}`),
  identity: (id: string) => call<IdentityView>('GET', `/api/mimics/${id}/identity`),
  confirm: (id: string, candidateId: string | null) =>
    call<{ ok: true }>('POST', `/api/mimics/${id}/identity/confirm`, { candidateId }),
  finishIdentity: (id: string) => call<{ ok: true }>('POST', `/api/mimics/${id}/identity/finish`),
  searchAgain: (id: string, link: string) =>
    call<{ ok: true }>('POST', `/api/mimics/${id}/identity/search`, { link }),
  setScope: (id: string, scope: MimicScope) => call<ScopeChange>('PATCH', `/api/mimics/${id}/scope`, scope),
  decline: (id: string, questionId: string) =>
    call<ScopeChange>('POST', `/api/mimics/${id}/decline`, { questionId }),
  setFact: (id: string, factId: string, userState: 'active' | 'removed') =>
    call<{ id: string }>('PATCH', `/api/mimics/${id}/facts/${factId}`, { userState }),
  next: (id: string) => call<NextResult>('POST', `/api/mimics/${id}/next`),
  answer: (id: string, b: AnswerRequest) => call<AnswerResult>('POST', `/api/mimics/${id}/answers`, b),
  rewind: (id: string, questionId: string) =>
    call<RewindResult>('POST', `/api/mimics/${id}/rewind`, { questionId }),
  draft: (id: string, scenario: string) =>
    call<{ draft: Draft }>('POST', `/api/mimics/${id}/ask`, { scenario }),
  predict: (id: string, question: Draft & { rationale: boolean }) =>
    call<PlaygroundPrediction>('POST', `/api/mimics/${id}/ask`, { question }),
  soul: (id: string) => call<SoulView>('GET', `/api/mimics/${id}/soul`),
  draftSoul: (id: string) => call<SoulView>('POST', `/api/mimics/${id}/soul`),
  curateSoul: (id: string, save: SoulSave) => call<SoulView>('PUT', `/api/mimics/${id}/soul`, save),
  /** Fire-and-forget save that outlives the page (leaving it mid-debounce); the server orders saves by rev. */
  curateSoulOnLeave: (id: string, save: SoulSave) =>
    void fetch(`/api/mimics/${id}/soul`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(save),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {}),
  teach: (id: string, feedback: FeedbackRequest) =>
    call<FeedbackResult>('POST', `/api/mimics/${id}/ask`, { feedback }),
  playground: (id: string) => call<PlaygroundHistory>('GET', `/api/mimics/${id}/ask`),
  stop: (id: string) => call<{ snapshotVersion: number | null }>('POST', `/api/mimics/${id}/stop`),
  remove: (id: string) => call<{ deleted: true }>('DELETE', `/api/mimics/${id}`),
  // Lab (admin only)
  createConfig: (label: string, config: unknown) =>
    call<{ hash: string }>('POST', '/api/lab/configs', { label, config }),
  saveExperiment: (e: ExperimentRequest) => call<ExperimentRecord>('POST', '/api/lab/experiments', e),
  setupPreset: (id: string) =>
    call<{ experiment: ExperimentRecord; created: boolean }>('POST', '/api/lab/experiments/preset', { id }),
};

/** An experiment preset as `/lab` lists it (ADR-0045). */
export interface PresetInfo {
  id: string;
  name: string;
  summary: string;
}

export interface ExperimentRequest {
  id?: string;
  name: string;
  status: ExperimentRecord['status'];
  arms: ExperimentRecord['arms'];
}
