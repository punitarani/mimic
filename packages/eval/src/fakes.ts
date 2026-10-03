import {
  type ChatRequest,
  type ChatResponse,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
  type LlmClient,
  sha256Hex,
} from '@mimic/core';

/**
 * Deterministic offline stand-ins for Jev and the LLMs. They make the engine runnable with zero spend (tests and
 * `--offline` CLI runs). Their outputs are arbitrary: never report metrics from them.
 */

function unit(seed: string, i = 0): number {
  return Number.parseInt(sha256Hex(`${seed}:${i}`).slice(0, 8), 16) / 0x100000000;
}

function randomDist(keys: string[], seed: string): Record<string, number> {
  const raw = keys.map((_, i) => unit(seed, i) ** 2 + 0.02);
  const sum = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, raw[i]! / sum]));
}

const GOOD_GATES: Record<string, number> = {
  ambiguous: 0.1,
  sensitive: 0.02,
  leading: 0.1,
  quick: 0.95,
  concrete: 0.9,
  demeaning: 0.03,
};

/** Self-rating openers the `concrete` gate rejects (ADR-0042). */
const SELF_RATING =
  /how well does this describe you|how much do you agree|rate yourself|do you consider yourself/i;
/** Loaded wording the `demeaning` gate rejects. */
const LOADED = /\b(admit|weakness|abnormal|shameful)\b/i;
/** Topic words per sensitive area, and how the `sensitive` gate names the area. */
const AREA_TOPICS: Array<[string, RegExp]> = [
  ['health', /\b(doctor|diet|illness|medication)\b/i],
  ['sexuality', /\b(sex|sexual|intimate)\b/i],
  ['religion', /\b(pray|church|religious|faith)\b/i],
  ['politics', /\b(vote|voted|voting|election|political)\b/i],
  ['detailed personal finances', /\b(debt|salary|savings)\b/i],
];

/**
 * Offline stand-in for the gates: good by default, but it fails a self-rating on `concrete`, loaded wording on
 * `demeaning`, and a prompt on `sensitive` when it touches an area the gate asks about.
 */
function fakeGate(key: string, instructions: string, prompt: string | undefined): number | undefined {
  if (prompt === undefined) return GOOD_GATES[key];
  if (key === 'concrete') return SELF_RATING.test(prompt) ? 0.1 : 0.9;
  if (key === 'demeaning') return LOADED.test(prompt) ? 0.9 : 0.03;
  if (key === 'sensitive')
    return AREA_TOPICS.some(([area, re]) => instructions.includes(area) && re.test(prompt)) ? 0.9 : 0.02;
  return GOOD_GATES[key];
}

export class FakeDecisions implements DecisionProvider {
  readonly provider = 'fake-decisions';
  calls = 0;

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls++;
    const stateSeed = sha256Hex(JSON.stringify(req.state));
    const gatePrompt = (req.state as { question?: { prompt?: unknown } }).question?.prompt;
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      const seed = `${stateSeed}:${key}`;
      if (q.type === 'noul') {
        const gate = fakeGate(key, q.instructions, typeof gatePrompt === 'string' ? gatePrompt : undefined);
        answers[key] = { type: 'noul', p: gate ?? 0.15 + 0.7 * unit(seed) };
      } else if (q.type === 'choice') {
        const probabilities = randomDist(Object.keys(q.criteria), seed);
        const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
        answers[key] = { type: 'choice', choice, confidence: 0.5, probabilities };
      } else {
        const probabilities = randomDist(
          q.criteria.map((_, i) => String(i)),
          seed,
        );
        const score = Object.entries(probabilities).reduce((a, [k, p]) => a + Number(k) * p, 0);
        answers[key] = { type: 'score', score, confidence: 0.4 + 0.4 * unit(seed, 99), probabilities };
      }
    }
    const inputTokens = Math.ceil(JSON.stringify(req).length / 4);
    return {
      modelSnapshot: `${req.model}-fake`,
      answers,
      usage: { inputTokens, outputTokens: 0, costUsd: 0 },
      latencyMs: 1,
      raw: { fake: true },
    };
  }
}

const SCENARIOS = [
  'A friend cancels plans last minute. Do you reschedule right away?',
  'Your team debates a risky new tool. Which way do you lean?',
  'You find a cheaper flight with two layovers. Which do you book?',
  'A colleague takes credit for your idea in a meeting. What do you do?',
  'You have an unexpected free afternoon. How do you spend it?',
  'A new restaurant opens nearby. When do you try it?',
  'Your manager asks for a quick estimate on a vague task. How do you answer?',
  'You are offered a stretch role with unclear scope. Do you take it?',
  'A neighbor asks to borrow your car for a day. Do you lend it?',
  'You can finish a report today or polish it until Friday. Which do you pick?',
  'A group chat argues about weekend plans. How involved do you get?',
  'You notice a small error in a shipped project. What do you do first?',
  'Picking a gym: close and basic, or far and fancy?',
  'A stranger asks you for directions in a hurry. How do you respond?',
  'You get two job interviews on the same day. How do you handle it?',
  'Planning a birthday dinner: book early or decide that day?',
  'Your inbox has 200 unread emails. Where do you start?',
  'A coworker keeps interrupting you. How do you address it?',
  'Choosing a vacation: a known favorite or somewhere new?',
  'You can learn a new skill at work or deepen an existing one. Which one?',
  'A presentation slot opens up at a big meeting. Do you volunteer?',
  'Your friend asks for honest feedback on their business idea. How blunt are you?',
  'Buying a laptop: best specs or best value?',
  'You are running late to a casual meetup. What do you do?',
  'A project has no clear owner. Do you step in?',
  'You win a small prize. Spend it now or save it?',
  'At a party where you know one person, what do you do?',
  'A decision at work needs data you do not have yet. Do you wait?',
  'Your routine gets disrupted by travel. How do you feel?',
  'Writing a message to a new client: formal or casual?',
];

/**
 * Drafts a gen.v3 batch appends. A self-rating (fails `concrete`); an untagged religious question (fails `sensitive`);
 * a political question (rejected as out of scope without consent); a loaded religion question (rejected without
 * consent, fails `demeaning` with it).
 */
/** What the fake reflector and hypothesis writer infer without being told (ADR-0043). */
export const ROGUE_REFLECTION = {
  insight: 'Sounds deeply religious and guided by faith.',
  fact: 'Sunday mass',
  hypothesis: 'Probably goes to church every Sunday.',
} as const;

export const ROGUE_PROMPTS = {
  selfRating: 'How well does this describe you? "I plan my week ahead."',
  untagged: 'Would you pray before making a big decision?',
  political: 'In a close national election, which party would you vote for?',
  loaded: 'Can you admit that religious faith is a weakness?',
} as const;

function ROGUE_DRAFTS(target: string) {
  const scale = ['Very inaccurate', 'Inaccurate', 'Neither', 'Accurate', 'Very accurate'];
  return [
    {
      type: 'score',
      domain: 'core',
      prompt: ROGUE_PROMPTS.selfRating,
      options: scale.map((label, j) => ({ key: String(j), label })),
      facetIds: [target],
      rationale: 'fake rogue',
    },
    {
      type: 'noul',
      domain: 'casual',
      prompt: ROGUE_PROMPTS.untagged,
      options: [
        { key: 'yes', label: 'Yes' },
        { key: 'no', label: 'No' },
      ],
      facetIds: [target],
      rationale: 'fake rogue',
    },
    {
      type: 'score',
      domain: 'core',
      prompt: ROGUE_PROMPTS.political,
      options: ['Clearly left', 'Centre-left', 'Centre', 'Centre-right', 'Clearly right'].map((label, j) => ({
        key: String(j),
        label,
      })),
      facetIds: ['political_leaning'],
      rationale: 'fake rogue',
    },
    {
      type: 'noul',
      domain: 'core',
      prompt: ROGUE_PROMPTS.loaded,
      options: [
        { key: 'yes', label: 'Yes' },
        { key: 'no', label: 'No' },
      ],
      facetIds: ['religiosity'],
      rationale: 'fake rogue',
    },
  ];
}

function userText(req: ChatRequest): string {
  return req.messages.find((m) => m.role === 'user')?.content ?? '';
}

function systemText(req: ChatRequest): string {
  return req.messages.find((m) => m.role === 'system')?.content ?? '';
}

/** The sentence the fake reflection model adds; tests key fake predictors on it to make an improvement detectable. */
export const FAKE_REFLECTION_HINT = 'Weigh earlier answers first.';

export class FakeLlm implements LlmClient {
  readonly provider = 'fake-llm';
  calls = 0;
  private generated = 0;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const sys = systemText(req);
    const user = userText(req);
    let out: unknown;
    let text: string | undefined;
    if (sys.startsWith('You improve one text component')) {
      // Reflection (mimic-eval optimize): the current text plus one generic sentence, keeping every placeholder.
      const current = user.split('CURRENT TEXT:\n<<<\n')[1]?.split('\n>>>')[0] ?? '';
      text = `<component>${current} ${FAKE_REFLECTION_HINT}</component>`;
    } else if (sys.startsWith('You analyze where a predictor'))
      text = '1. Fake analysis: misses cluster on scale items.';
    else if (sys.startsWith('You write short, concrete questions')) out = this.generate(user);
    else if (sys.startsWith("You analyze one person's answers")) out = this.reflect(user, sys);
    else if (sys.startsWith('Estimate the probability')) out = this.predict(user);
    else if (sys.startsWith('You have been given a file')) out = this.predict(user);
    else if (sys.startsWith('You read documents one person wrote')) out = this.footprint(user);
    else if (sys.startsWith("Given a person's occupation")) out = this.occFacets();
    else if (sys.startsWith('Write {k}') || /^Write \d+ distinct/.test(sys)) out = this.hypotheses(user);
    else if (sys.startsWith("Turn the person's scenario")) out = this.ask(user);
    else if (sys.startsWith('You write the portrait at the heart of a SOUL.md')) out = this.soul(user);
    else if (sys.startsWith('Write one short sentence'))
      out = { sentence: 'I tend to go with what worked before.' };
    else if (sys.startsWith('You choose the next question in an interview'))
      // E10's LLM chooser: the first candidate listed (a deterministic, valid pick).
      out = { key: user.match(/^(q\d+):/m)?.[1] ?? 'q01' };
    else if (sys.startsWith('You write the next question in an interview')) {
      const n = Number(sys.match(/Write (\d+) different/)?.[1] ?? 1);
      out = {
        questions: Array.from({ length: n }, (_, i) => ({
          prompt: SCENARIOS[i % SCENARIOS.length]!,
          options: ['Yes', 'No'],
        })),
      };
    } else out = {};
    return {
      content: text ?? JSON.stringify(out),
      modelSnapshot: `${req.model}@fake`,
      provider: 'fake',
      usage: { inputTokens: Math.ceil(user.length / 4), outputTokens: 50, costUsd: 0 },
      latencyMs: 1,
      raw: { fake: true },
    };
  }

  private generate(user: string) {
    const n = Number(user.match(/Write (\d+) questions/)?.[1] ?? 6);
    const targets = (user.match(/Target facets: (.*)/)?.[1] ?? 'risk_tolerance')
      .split(',')
      .map((s) => s.trim());
    const questions = [];
    for (let i = 0; i < n; i++) {
      const idx = this.generated++;
      const prompt = SCENARIOS[idx % SCENARIOS.length]!;
      const variant = Math.floor(idx / SCENARIOS.length);
      const facet = targets[i % targets.length]!;
      const kind = idx % 3;
      questions.push({
        type: kind === 0 ? 'choice' : kind === 1 ? 'noul' : 'score',
        domain: idx % 2 ? 'casual' : 'professional',
        prompt: variant ? `${prompt} (round ${variant + 1})` : prompt,
        options:
          kind === 0
            ? [
                { key: 'a', label: 'Act right away' },
                { key: 'b', label: 'Wait and see' },
                { key: 'c', label: 'Ask someone first' },
              ]
            : kind === 1
              ? [
                  { key: 'yes', label: 'Yes' },
                  { key: 'no', label: 'No' },
                ]
              : ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'].map((label, j) => ({
                  key: String(j),
                  label,
                })),
        facetIds: [facet],
        rationale: 'fake',
      });
    }
    // gen.v3 batches also carry drafts the pipeline must never pool (ADR-0042), so tests see each guard work.
    if (user.includes('Category quota:')) questions.push(...ROGUE_DRAFTS(targets[0]!));
    return { questions };
  }

  private reflect(user: string, sys = '') {
    const newBlock = user.split('NEW EVIDENCE:')[1]?.split('RELEVANT EARLIER EVIDENCE:')[0] ?? '';
    const seqs = [...newBlock.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    if (!seqs.length) return { insights: [], facts: [], contradictions: [] };
    // A reflector that infers what it must not (ADR-0043): religion from whatever the latest answer was. The guard
    // keeps these only when that answer was to a direct religion question.
    const rogue = sys.includes('religiosity [sensitive]')
      ? {
          insights: [
            {
              text: ROGUE_REFLECTION.insight,
              facetIds: ['religiosity'],
              evidenceSeqs: [seqs.at(-1)!],
              confidence: 0.6,
            },
          ],
          facts: [{ predicate: 'hasInterest', object: ROGUE_REFLECTION.fact, evidenceSeqs: [seqs.at(-1)!] }],
        }
      : { insights: [], facts: [] };
    return {
      insights: [
        {
          text: `Across answers ${seqs.slice(0, 3).join(', ')}, tends to pick the practical option.`,
          facetIds: ['deliberation'],
          evidenceSeqs: seqs.slice(0, 3),
          confidence: 0.55,
        },
        { text: 'An uncited claim that must be dropped.', facetIds: [], evidenceSeqs: [], confidence: 0.9 },
        ...rogue.insights,
      ],
      facts: [
        { predicate: 'hasInterest', object: 'Planning trips', evidenceSeqs: [seqs[0]!] },
        ...rogue.facts,
      ],
      contradictions: [],
    };
  }

  private soul(user: string) {
    const seqs = [...(user.split('ANSWERS:')[1] ?? '').matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
    const cite = (i: number) => seqs.filter((_, j) => j % 3 === i % 3).slice(0, 3);
    return {
      summary: 'They decide quickly on everyday matters and slow down when other people are affected.',
      statements: [
        {
          section: 'decision_style',
          text: 'Decides fast when a choice is easy to undo.',
          evidenceSeqs: cite(0),
          confidence: 0.7,
        },
        {
          section: 'principles',
          text: 'When a plan changes, they adapt rather than push back.',
          evidenceSeqs: cite(1),
          confidence: 0.6,
        },
        {
          section: 'tradeoffs',
          text: 'Prefers finishing on time over polishing.',
          evidenceSeqs: cite(2),
          confidence: 0.45,
        },
        {
          section: 'biases',
          text: 'Leans on what worked before, even when conditions changed.',
          evidenceSeqs: cite(0),
          confidence: 0.55,
        },
        {
          section: 'tensions',
          text: 'Careful with plans at work, loose with them at home.',
          evidenceSeqs: cite(1),
          confidence: 0.5,
        },
        {
          section: 'values',
          text: 'An uncited claim that must be dropped.',
          evidenceSeqs: [],
          confidence: 0.9,
        },
        {
          section: 'values',
          text: 'A claim citing answers that do not exist.',
          evidenceSeqs: [99_999],
          confidence: 0.9,
        },
      ],
    };
  }

  /**
   * Footprint proposals (ADR-0061): two items citing the first documents, one on an allowed facet, plus a rogue item
   * on a sensitive facet and one citing no document, which the engine must drop.
   */
  private footprint(user: string) {
    const docIds = [...user.matchAll(/^\[([a-f0-9]+)\]/gm)].map((m) => m[1]!);
    const facets = [
      ...(user.split('FACETS:')[1]?.split('DOCUMENTS:')[0] ?? '').matchAll(/^([a-z_]+):/gm),
    ].map((m) => m[1]!);
    const facet = facets[0] ?? 'risk_tolerance';
    return {
      items: [
        {
          type: 'choice',
          prompt: 'A side project stalls for a month. What do you do with it?',
          options: [
            { key: 'a', label: 'Pick it back up this weekend' },
            { key: 'b', label: 'Archive it and start something new' },
          ],
          facetIds: [facet],
          answer: 'a',
          confidence: 0.7,
          docIds: docIds.slice(0, 1),
        },
        {
          type: 'noul',
          prompt: 'Would you rewrite a working tool just to use a newer language?',
          options: [
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ],
          facetIds: [facets[1] ?? facet],
          answer: 'yes',
          confidence: 0.6,
          docIds: docIds.slice(0, 2),
        },
        {
          type: 'noul',
          prompt: 'Do you pray before a big decision?',
          options: [
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ],
          facetIds: ['religiosity'],
          answer: 'yes',
          confidence: 0.9,
          docIds: docIds.slice(0, 1),
        },
        {
          type: 'noul',
          prompt: 'Would you take a job with a longer commute for more pay?',
          options: [
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ],
          facetIds: [facet],
          answer: 'no',
          confidence: 0.8,
          docIds: [],
        },
      ],
    };
  }

  private predict(user: string) {
    const keys = [...(user.split('OPTIONS:')[1] ?? '').matchAll(/^(\w+):/gm)].map((m) => m[1]!);
    return { probs: keys.map((key) => ({ key, p: 1 / keys.length })) };
  }

  private occFacets() {
    const labels = (lo: string, hi: string) => [
      lo,
      `Leans ${lo.toLowerCase()}`,
      'Balanced',
      `Leans ${hi.toLowerCase()}`,
      hi,
    ];
    return {
      facets: [
        {
          id: 'occ_prototype_first',
          name: 'prototype first',
          low: 'Design first',
          high: 'Prototype first',
          labels: labels('Design first', 'Prototype first'),
        },
        {
          id: 'occ_tooling',
          name: 'tooling appetite',
          low: 'Proven tools',
          high: 'New tools',
          labels: labels('Proven tools', 'New tools'),
        },
        {
          id: 'occ_review_depth',
          name: 'review depth',
          low: 'Light reviews',
          high: 'Deep reviews',
          labels: labels('Light reviews', 'Deep reviews'),
        },
      ],
    };
  }

  private hypotheses(user: string) {
    const k = Number(user.match(/K: (\d+)/)?.[1] ?? 3);
    return {
      hypotheses: Array.from({ length: k }, (_, i) => ({
        id: `h${i}`,
        // Reading 1 also guesses a religion it was never told (ADR-0043): the guard strips that sentence.
        text: `Reading ${i + 1}: this person leans ${['cautious', 'bold', 'balanced', 'social', 'independent'][i % 5]} in new situations.${i === 0 ? ` ${ROGUE_REFLECTION.hypothesis}` : ''}`,
        leanings: [],
      })),
    };
  }

  private ask(user: string) {
    const scenario = user.replace('SCENARIO:', '').trim();
    return {
      type: 'choice',
      prompt: scenario.length < 120 ? scenario : 'What would you do in this situation?',
      options: [
        { key: 'a', label: 'Go for it' },
        { key: 'b', label: 'Hold off' },
      ],
    };
  }
}
