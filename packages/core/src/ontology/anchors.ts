import type { Domain, Option, QType } from '../types';

export interface ItemTemplate {
  itemKey: string;
  type: QType;
  domain: Domain;
  prompt: string;
  options: Option[];
  facetIds: string[];
  /** Deterministic psychometric scoring (PLAN §9.8): the facet this item keys, and whether it is reversed. */
  psychometric?: { facetId: string; reverse: boolean };
}

const ACCURACY_SCALE: Option[] = [
  { key: '0', label: 'Very inaccurate' },
  { key: '1', label: 'Moderately inaccurate' },
  { key: '2', label: 'Neither accurate nor inaccurate' },
  { key: '3', label: 'Moderately accurate' },
  { key: '4', label: 'Very accurate' },
];

const ipip = (key: string, facetId: string, statement: string): ItemTemplate => ({
  itemKey: `anchors.v1/${key}`,
  type: 'score',
  domain: 'core',
  prompt: `How well does this describe you? "${statement}"`,
  options: ACCURACY_SCALE,
  facetIds: [facetId],
  psychometric: { facetId, reverse: false },
});

/**
 * anchors.v1 (PLAN §9.3). Big Five items are positively keyed IPIP markers (public domain,
 * https://ipip.ori.org). Shown to everyone, in a per-person random order.
 */
export const ANCHORS_V1: ItemTemplate[] = [
  ipip('bf_extraversion', 'extraversion', 'I am the life of the party.'),
  ipip('bf_agreeableness', 'agreeableness', "I sympathize with others' feelings."),
  ipip('bf_conscientiousness', 'conscientiousness', 'I get chores done right away.'),
  ipip('bf_emotional_stability', 'emotional_stability', 'I am relaxed most of the time.'),
  ipip('bf_openness', 'openness', 'I have a vivid imagination.'),
  {
    itemKey: 'anchors.v1/risk_gamble',
    type: 'choice',
    domain: 'core',
    prompt: 'Which would you take?',
    options: [
      { key: 'a', label: '$500 for sure' },
      { key: 'b', label: 'A coin flip: $1,100 if heads, nothing if tails' },
    ],
    facetIds: ['risk_tolerance', 'loss_aversion'],
  },
  {
    itemKey: 'anchors.v1/intertemporal',
    type: 'choice',
    domain: 'core',
    prompt: 'Which would you rather receive?',
    options: [
      { key: 'a', label: '$100 today' },
      { key: 'b', label: '$120 in one month' },
    ],
    facetIds: ['patience'],
  },
  {
    itemKey: 'anchors.v1/trust_game',
    type: 'choice',
    domain: 'core',
    prompt:
      'You get $10. Whatever you send a stranger triples, and they decide how much to send back. How much do you send?',
    options: [
      { key: 'a', label: 'Nothing' },
      { key: 'b', label: '$3' },
      { key: 'c', label: '$5' },
      { key: 'd', label: 'All $10' },
    ],
    facetIds: ['trust', 'reciprocity'],
  },
  {
    itemKey: 'anchors.v1/work_ship_or_polish',
    type: 'choice',
    domain: 'professional',
    prompt: "Your project is due Friday and it's 80% done. Your manager offers a one-week extension. You:",
    options: [
      { key: 'a', label: 'Ship it Friday and improve it after' },
      { key: 'b', label: 'Take the extra week to get it right' },
    ],
    facetIds: ['speed_vs_quality', 'detail_orientation'],
  },
  {
    itemKey: 'anchors.v1/free_saturday',
    type: 'choice',
    domain: 'casual',
    prompt: 'You have a free Saturday with no plans. What sounds best?',
    options: [
      { key: 'a', label: 'Meeting up with friends' },
      { key: 'b', label: 'A quiet day at home' },
      { key: 'c', label: 'Exploring somewhere new on your own' },
    ],
    facetIds: ['social_energy', 'taste_novelty'],
  },
];

export const ANCHOR_SETS: Record<string, ItemTemplate[]> = { 'anchors.v1': ANCHORS_V1 };
