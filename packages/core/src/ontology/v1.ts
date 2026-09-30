import type { Category, Facet } from '../types';

type L5 = [string, string, string, string, string];

/**
 * The category of each v1 group (ADR-0036). `spending_style` sits in Everyday but belongs to "Work and money", so a
 * facet keeps one category across ontology versions (it moves to the Money group in v2).
 */
const GROUP_CATEGORY: Record<string, Category> = {
  Personality: 'psychology',
  Decisions: 'psychology',
  Values: 'values',
  Social: 'life',
  Everyday: 'life',
  Communication: 'life',
  Work: 'work',
};
const CATEGORY_OVERRIDE: Record<string, Category> = { spending_style: 'work' };

const f = (id: string, group: string, name: string, low: string, high: string, labels: L5): Facet => ({
  id,
  group,
  name,
  low,
  high,
  labels,
  category: CATEGORY_OVERRIDE[id] ?? GROUP_CATEGORY[group]!,
});

/** Ontology v1 (PLAN Appendix C). Labels are written from the poles, as in PLAN B.2. */
export const ONTOLOGY_V1: Facet[] = [
  // Personality
  f('openness', 'Personality', 'openness', 'Prefers the familiar', 'Seeks novelty and ideas', [
    'Strongly prefers the familiar',
    'Leans toward the familiar',
    'Balanced',
    'Leans toward novelty and ideas',
    'Strongly seeks novelty and ideas',
  ]),
  f(
    'conscientiousness',
    'Personality',
    'conscientiousness',
    'Flexible, spontaneous',
    'Organized, disciplined',
    [
      'Very flexible and spontaneous',
      'Leans flexible',
      'Balanced',
      'Leans organized',
      'Very organized and disciplined',
    ],
  ),
  f('extraversion', 'Personality', 'extraversion', 'Reserved', 'Outgoing', [
    'Very reserved',
    'Leans reserved',
    'Balanced',
    'Leans outgoing',
    'Very outgoing',
  ]),
  f('agreeableness', 'Personality', 'agreeableness', 'Challenging', 'Accommodating', [
    'Very challenging',
    'Leans challenging',
    'Balanced',
    'Leans accommodating',
    'Very accommodating',
  ]),
  f('emotional_stability', 'Personality', 'emotional stability', 'Easily stressed', 'Even-keeled', [
    'Very easily stressed',
    'Leans easily stressed',
    'Balanced',
    'Leans even-keeled',
    'Very even-keeled',
  ]),
  // Values
  f(
    'openness_to_change',
    'Values',
    'openness to change',
    'Tradition and stability',
    'Independence and stimulation',
    [
      'Strongly values tradition and stability',
      'Leans toward tradition and stability',
      'Balanced',
      'Leans toward independence and stimulation',
      'Strongly values independence and stimulation',
    ],
  ),
  f('self_enhancement', 'Values', 'self-enhancement', 'Modest ambitions', 'Achievement and status', [
    'Very modest ambitions',
    'Leans modest',
    'Balanced',
    'Leans toward achievement and status',
    'Strongly driven by achievement and status',
  ]),
  f('conservation', 'Values', 'conservation', 'Questions rules', 'Values order and security', [
    'Strongly questions rules',
    'Leans toward questioning rules',
    'Balanced',
    'Leans toward order and security',
    'Strongly values order and security',
  ]),
  f('self_transcendence', 'Values', 'self-transcendence', 'Focus on self', "Focus on others' welfare", [
    'Strongly focused on self',
    'Leans toward self',
    'Balanced',
    "Leans toward others' welfare",
    "Strongly focused on others' welfare",
  ]),
  // Decisions
  f('risk_tolerance', 'Decisions', 'risk tolerance', 'Avoids risk', 'Seeks risk', [
    'Strongly avoids risk',
    'Leans cautious',
    'Balanced',
    'Leans toward risk',
    'Strongly seeks risk',
  ]),
  f('patience', 'Decisions', 'patience', 'Wants it now', 'Waits for more later', [
    'Strongly wants it now',
    'Leans toward now',
    'Balanced',
    'Leans toward waiting for more',
    'Strongly prefers waiting for more later',
  ]),
  f('loss_aversion', 'Decisions', 'loss aversion', 'Losses and gains weigh the same', 'Losses loom larger', [
    'Losses and gains weigh the same',
    'Losses weigh slightly more',
    'Losses weigh somewhat more',
    'Losses weigh clearly more',
    'Losses loom much larger than gains',
  ]),
  f(
    'ambiguity_tolerance',
    'Decisions',
    'ambiguity tolerance',
    'Needs certainty',
    'Comfortable with unknowns',
    [
      'Strongly needs certainty',
      'Leans toward certainty',
      'Balanced',
      'Leans comfortable with unknowns',
      'Very comfortable with unknowns',
    ],
  ),
  f('maximizing', 'Decisions', 'maximizing', 'Good enough is fine', 'Must find the best', [
    'Good enough is always fine',
    'Leans toward good enough',
    'Balanced',
    'Leans toward finding the best',
    'Must always find the best',
  ]),
  f('deliberation', 'Decisions', 'deliberation', 'Goes with gut', 'Thinks it through', [
    'Always goes with gut',
    'Leans toward gut',
    'Balanced',
    'Leans toward thinking it through',
    'Always thinks it through',
  ]),
  // Social
  f('trust', 'Social', 'trust', 'Wary of others', 'Trusts by default', [
    'Very wary of others',
    'Leans wary',
    'Balanced',
    'Leans trusting',
    'Trusts by default',
  ]),
  f('reciprocity', 'Social', 'reciprocity', 'Transactional', 'Strongly fair and reciprocal', [
    'Very transactional',
    'Leans transactional',
    'Balanced',
    'Leans fair and reciprocal',
    'Strongly fair and reciprocal',
  ]),
  f('conformity', 'Social', 'conformity', 'Goes own way', 'Follows the group', [
    'Strongly goes own way',
    'Leans toward own way',
    'Balanced',
    'Leans toward the group',
    'Strongly follows the group',
  ]),
  f('conflict_directness', 'Social', 'conflict directness', 'Avoids conflict', 'Addresses it head-on', [
    'Strongly avoids conflict',
    'Leans toward avoiding conflict',
    'Balanced',
    'Leans toward addressing it',
    'Addresses conflict head-on',
  ]),
  // Work
  f('autonomy', 'Work', 'autonomy', 'Prefers direction', 'Prefers full ownership', [
    'Strongly prefers direction',
    'Leans toward direction',
    'Balanced',
    'Leans toward ownership',
    'Strongly prefers full ownership',
  ]),
  f('planning', 'Work', 'planning', 'Improvises', 'Plans ahead', [
    'Always improvises',
    'Leans toward improvising',
    'Balanced',
    'Leans toward planning',
    'Always plans ahead',
  ]),
  f('detail_orientation', 'Work', 'detail orientation', 'Big picture', 'Details', [
    'Strongly big-picture',
    'Leans big-picture',
    'Balanced',
    'Leans detail-oriented',
    'Strongly detail-oriented',
  ]),
  f('collaboration', 'Work', 'collaboration', 'Works alone', 'Works with others', [
    'Strongly prefers working alone',
    'Leans toward working alone',
    'Balanced',
    'Leans toward working with others',
    'Strongly prefers working with others',
  ]),
  f('leadership_drive', 'Work', 'leadership drive', 'Prefers to contribute', 'Prefers to lead', [
    'Strongly prefers to contribute',
    'Leans toward contributing',
    'Balanced',
    'Leans toward leading',
    'Strongly prefers to lead',
  ]),
  f('speed_vs_quality', 'Work', 'speed vs. quality', 'Polish first', 'Ship fast', [
    'Always polishes first',
    'Leans toward polish',
    'Balanced',
    'Leans toward shipping fast',
    'Always ships fast',
  ]),
  // Everyday
  f('routine', 'Everyday', 'routine', 'Spontaneous days', 'Structured routines', [
    'Very spontaneous days',
    'Leans spontaneous',
    'Balanced',
    'Leans toward routines',
    'Very structured routines',
  ]),
  f('social_energy', 'Everyday', 'social energy', 'Recharges alone', 'Recharges with people', [
    'Strongly recharges alone',
    'Leans toward recharging alone',
    'Balanced',
    'Leans toward recharging with people',
    'Strongly recharges with people',
  ]),
  f('spending_style', 'Everyday', 'spending style', 'Frugal', 'Indulgent', [
    'Very frugal',
    'Leans frugal',
    'Balanced',
    'Leans indulgent',
    'Very indulgent',
  ]),
  f('taste_novelty', 'Everyday', 'taste novelty', 'Sticks with favorites', 'Tries new things', [
    'Always sticks with favorites',
    'Leans toward favorites',
    'Balanced',
    'Leans toward new things',
    'Always tries new things',
  ]),
  // Communication
  f('directness', 'Communication', 'directness', 'Diplomatic, indirect', 'Blunt', [
    'Very diplomatic and indirect',
    'Leans diplomatic',
    'Balanced',
    'Leans blunt',
    'Very blunt',
  ]),
  f('formality', 'Communication', 'formality', 'Casual', 'Formal', [
    'Very casual',
    'Leans casual',
    'Balanced',
    'Leans formal',
    'Very formal',
  ]),
  f('verbosity', 'Communication', 'verbosity', 'Brief', 'Detailed', [
    'Very brief',
    'Leans brief',
    'Balanced',
    'Leans detailed',
    'Very detailed',
  ]),
  f('humor', 'Communication', 'humor', 'Serious', 'Playful', [
    'Very serious',
    'Leans serious',
    'Balanced',
    'Leans playful',
    'Very playful',
  ]),
];

export const FACET_GROUPS = [
  'Personality',
  'Values',
  'Decisions',
  'Social',
  'Work',
  'Everyday',
  'Communication',
];
