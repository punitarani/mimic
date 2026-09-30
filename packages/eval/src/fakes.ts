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

const GOOD_GATES: Record<string, number> = { ambiguous: 0.1, sensitive: 0.02, leading: 0.1, quick: 0.95 };

export class FakeDecisions implements DecisionProvider {
  readonly provider = 'fake-decisions';
  calls = 0;

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls++;
    const stateSeed = sha256Hex(JSON.stringify(req.state));
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      const seed = `${stateSeed}:${key}`;
      if (q.type === 'noul') {
        answers[key] = { type: 'noul', p: GOOD_GATES[key] ?? 0.15 + 0.7 * unit(seed) };
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

function userText(req: ChatRequest): string {
  return req.messages.find((m) => m.role === 'user')?.content ?? '';
}

function systemText(req: ChatRequest): string {
  return req.messages.find((m) => m.role === 'system')?.content ?? '';
}

export class FakeLlm implements LlmClient {
  readonly provider = 'fake-llm';
  calls = 0;
  private generated = 0;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const sys = systemText(req);
    const user = userText(req);
    let out: unknown;
    if (sys.startsWith('You write short, concrete questions')) out = this.generate(user);
    else if (sys.startsWith("You analyze one person's answers")) out = this.reflect(user);
    else if (sys.startsWith('Estimate the probability')) out = this.predict(user);
    else if (sys.startsWith("Given a person's occupation")) out = this.occFacets();
    else if (sys.startsWith('Write {k}') || /^Write \d+ distinct/.test(sys)) out = this.hypotheses(user);
    else if (sys.startsWith("Turn the person's scenario")) out = this.ask(user);
    else if (sys.startsWith('Write one short sentence'))
      out = { sentence: 'I tend to go with what worked before.' };
    else out = {};
    return {
      content: JSON.stringify(out),
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
    return { questions };
  }

  private reflect(user: string) {
    const newBlock = user.split('NEW EVIDENCE:')[1]?.split('RELEVANT EARLIER EVIDENCE:')[0] ?? '';
    const seqs = [...newBlock.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    if (!seqs.length) return { insights: [], facts: [], contradictions: [] };
    return {
      insights: [
        {
          text: `Across answers ${seqs.slice(0, 3).join(', ')}, tends to pick the practical option.`,
          facetIds: ['deliberation'],
          evidenceSeqs: seqs.slice(0, 3),
          confidence: 0.55,
        },
        { text: 'An uncited claim that must be dropped.', facetIds: [], evidenceSeqs: [], confidence: 0.9 },
      ],
      facts: [{ predicate: 'hasInterest', object: 'Planning trips', evidenceSeqs: [seqs[0]!] }],
      contradictions: [],
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
        text: `Reading ${i + 1}: this person leans ${['cautious', 'bold', 'balanced', 'social', 'independent'][i % 5]} in new situations.`,
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
