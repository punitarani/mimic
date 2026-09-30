import { EXPERIMENT_PRESETS, isPresetId, setupPreset } from '@mimic/core';
import type { LocalEngine } from './local';
import { runSession, SessionScript } from './session';

/**
 * `mimic-eval cohort` (ADR-0045): a scripted cohort run through an experiment preset in a local database, every persona
 * once in every arm, so the arms see the same people. It checks the machinery (which arm asks what, and when); a
 * scripted answerer can't measure accuracy, so its fidelity numbers are never results.
 */

/** Personas that vary occupation, categories and consents; each runs in every arm. */
export const COHORT_PERSONAS: Array<
  Omit<SessionScript, 'seed' | 'policy' | 'answers' | 'whys' | 'researchConsents'>
> = [
  {
    intake: { name: 'Maria Santos', location: 'Porto, PT', occupation: 'Nurse' },
    consentResearch: true,
    consents: { politics: true, religion: true, sexuality: true, health: true, money: true },
  },
  {
    intake: { name: 'Jonas Weber', location: 'Leipzig, DE', occupation: 'Teacher' },
    consentResearch: true,
    consents: { politics: true, health: true },
  },
  {
    intake: { name: 'Tom Becker', location: 'Berlin, DE', occupation: 'Accountant' },
    consentResearch: true,
    categories: ['psychology', 'values', 'life'],
    consents: { religion: true, sexuality: true },
  },
  {
    intake: { name: 'Aisha Khan', location: 'Leeds, UK', occupation: 'Electrician' },
    consentResearch: true,
    consents: {},
  },
  {
    intake: { name: 'Lucía Romero', location: 'Valencia, ES', occupation: 'Graphic designer' },
    consentResearch: true,
    consents: { money: true, health: true },
  },
  {
    intake: { name: 'Kenji Mori', location: 'Osaka, JP', occupation: 'Chef' },
    consentResearch: true,
    categories: ['psychology', 'life', 'work'],
    consents: { sexuality: true, money: true },
  },
  {
    intake: { name: 'Grace Okafor', location: 'Lagos, NG', occupation: 'Pharmacist' },
    consentResearch: true,
    consents: { politics: true, religion: true, sexuality: true, health: true, money: true },
  },
  {
    intake: { name: 'Olle Berg', location: 'Uppsala, SE', occupation: 'Software developer' },
    consentResearch: true,
    categories: ['psychology', 'values', 'work'],
    consents: { politics: true, money: true },
  },
];

export interface CohortResult {
  experimentId: string;
  mimics: Array<{ mimicId: string; arm: string; persona: string }>;
}

/**
 * Sets the preset up in this database, starts it here (a local cohort database only; in the app, starting stays a
 * person's click in `/lab`), and runs `people` personas once per arm for `turns` questions each.
 */
export async function runCohort(
  engine: LocalEngine,
  spec: {
    preset: string;
    people: number;
    turns: number;
    onSession?: (s: { persona: string; arm: string; mimicId: string }) => void;
  },
): Promise<CohortResult> {
  if (!isPresetId(spec.preset))
    throw new Error(`Unknown preset "${spec.preset}"; known: ${Object.keys(EXPERIMENT_PRESETS).join(', ')}`);
  const { experiment } = await setupPreset(engine.deps, spec.preset);
  for (const e of await engine.deps.store.listExperiments())
    if (e.status === 'active' && e.id !== experiment.id)
      await engine.deps.store.putExperiment({ ...e, status: 'stopped' });
  await engine.deps.store.putExperiment({ ...experiment, status: 'active' });
  const mimics: CohortResult['mimics'] = [];
  for (let i = 0; i < spec.people; i++) {
    const persona = COHORT_PERSONAS[i % COHORT_PERSONAS.length]!;
    const label = `${persona.intake.occupation ?? persona.intake.name} ${i + 1}`;
    const script = SessionScript.parse({ ...persona, seed: `cohort-${spec.preset}-${i}` });
    for (const { arm } of experiment.arms) {
      const { mimicId } = await runSession(engine, script, { turns: spec.turns, arm });
      mimics.push({ mimicId, arm, persona: label });
      spec.onSession?.({ persona: label, arm, mimicId });
    }
  }
  return { experimentId: experiment.id, mimics };
}
