import type { ItemTemplate } from './anchors';

const yn = [
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' },
];

/**
 * reserve.v1 (ADR-0006): static adaptive items served only when the generated pool is empty, so a session never
 * stalls waiting on an LLM. They are ordinary `adaptive` questions with generator `reserve.v1`.
 */
export const RESERVE_V1: ItemTemplate[] = [
  {
    itemKey: 'reserve.v1/restaurant',
    type: 'choice',
    domain: 'casual',
    prompt: 'At a restaurant you love, do you usually order your favorite dish or something new?',
    options: [
      { key: 'a', label: 'My favorite' },
      { key: 'b', label: 'Something new' },
    ],
    facetIds: ['taste_novelty'],
  },
  {
    itemKey: 'reserve.v1/feedback_style',
    type: 'choice',
    domain: 'professional',
    prompt: "A colleague's draft has a serious flaw. How do you tell them?",
    options: [
      { key: 'a', label: 'Say it plainly, right away' },
      { key: 'b', label: 'Start with what works, then raise it gently' },
      { key: 'c', label: 'Ask questions until they spot it themselves' },
    ],
    facetIds: ['directness', 'conflict_directness'],
  },
  {
    itemKey: 'reserve.v1/trip_planning',
    type: 'choice',
    domain: 'casual',
    prompt: 'For a week-long trip, how much do you plan before you leave?',
    options: [
      { key: 'a', label: 'A day-by-day itinerary' },
      { key: 'b', label: 'A few must-dos, the rest open' },
      { key: 'c', label: 'Just the flights and a bed' },
    ],
    facetIds: ['planning', 'routine'],
  },
  {
    itemKey: 'reserve.v1/big_purchase',
    type: 'score',
    domain: 'casual',
    prompt: 'Buying new headphones, how much research do you do?',
    options: [
      { key: '0', label: 'Buy the first decent pair' },
      { key: '1', label: 'Glance at a review' },
      { key: '2', label: 'Compare a few options' },
      { key: '3', label: 'Read several reviews' },
      { key: '4', label: 'Research until I find the best' },
    ],
    facetIds: ['maximizing', 'deliberation'],
  },
  {
    itemKey: 'reserve.v1/lead_or_contribute',
    type: 'choice',
    domain: 'professional',
    prompt: 'A new project team forms and nobody is in charge yet. You:',
    options: [
      { key: 'a', label: 'Step up to lead it' },
      { key: 'b', label: 'Take on a key piece and let someone else lead' },
    ],
    facetIds: ['leadership_drive', 'autonomy'],
  },
  {
    itemKey: 'reserve.v1/group_dinner',
    type: 'noul',
    domain: 'casual',
    prompt: "Friends pick a restaurant you don't love. Would you suggest a different place?",
    options: yn,
    facetIds: ['conformity', 'conflict_directness'],
  },
  {
    itemKey: 'reserve.v1/unclear_task',
    type: 'choice',
    domain: 'professional',
    prompt: "You're handed a task with vague requirements and a tight deadline. You:",
    options: [
      { key: 'a', label: 'Start building and adjust as you learn' },
      { key: 'b', label: 'Pin down the requirements before starting' },
    ],
    facetIds: ['ambiguity_tolerance', 'planning'],
  },
  {
    itemKey: 'reserve.v1/solo_or_team',
    type: 'score',
    domain: 'professional',
    prompt: 'For a hard problem at work, where do you do your best thinking?',
    options: [
      { key: '0', label: 'Entirely alone' },
      { key: '1', label: 'Mostly alone' },
      { key: '2', label: 'A mix' },
      { key: '3', label: 'Mostly with others' },
      { key: '4', label: 'Entirely with others' },
    ],
    facetIds: ['collaboration'],
  },
  {
    itemKey: 'reserve.v1/message_length',
    type: 'choice',
    domain: 'professional',
    prompt: 'You need a decision from a busy colleague. Your message is:',
    options: [
      { key: 'a', label: 'One line with the question' },
      { key: 'b', label: 'A short paragraph with context' },
      { key: 'c', label: 'A full write-up with options' },
    ],
    facetIds: ['verbosity'],
  },
  {
    itemKey: 'reserve.v1/windfall',
    type: 'choice',
    domain: 'casual',
    prompt: 'You unexpectedly get a $300 gift card for any store. You:',
    options: [
      { key: 'a', label: 'Treat yourself to something fun' },
      { key: 'b', label: 'Use it for things you would buy anyway' },
    ],
    facetIds: ['spending_style'],
  },
  {
    itemKey: 'reserve.v1/help_stranger',
    type: 'noul',
    domain: 'casual',
    prompt: 'Would you give up 30 minutes of your evening to help a neighbor you barely know move a couch?',
    options: yn,
    facetIds: ['self_transcendence', 'agreeableness'],
  },
  {
    itemKey: 'reserve.v1/job_offer',
    type: 'choice',
    domain: 'professional',
    prompt: 'Two job offers with equal pay. Which appeals more?',
    options: [
      { key: 'a', label: 'A stable company with a clear path' },
      { key: 'b', label: 'A young startup with a bigger role' },
    ],
    facetIds: ['risk_tolerance', 'openness_to_change'],
  },
  {
    itemKey: 'reserve.v1/rules',
    type: 'score',
    domain: 'professional',
    prompt: 'A team process feels pointless to you. What do you do?',
    options: [
      { key: '0', label: 'Ignore it and do it my way' },
      { key: '1', label: 'Work around it quietly' },
      { key: '2', label: 'Follow it but raise concerns' },
      { key: '3', label: 'Follow it and assume there is a reason' },
      { key: '4', label: 'Follow it exactly' },
    ],
    facetIds: ['conservation', 'conformity'],
  },
  {
    itemKey: 'reserve.v1/joke_meeting',
    type: 'noul',
    domain: 'professional',
    prompt: 'In a tense meeting, would you crack a joke to lighten the mood?',
    options: yn,
    facetIds: ['humor'],
  },
  {
    itemKey: 'reserve.v1/email_tone',
    type: 'choice',
    domain: 'professional',
    prompt: 'Writing to a senior person you have never met, you open with:',
    options: [
      { key: 'a', label: '"Hi [first name],"' },
      { key: 'b', label: '"Dear [full name],"' },
    ],
    facetIds: ['formality'],
  },
  {
    itemKey: 'reserve.v1/recognition',
    type: 'choice',
    domain: 'professional',
    prompt: 'Which would feel better after a big win at work?',
    options: [
      { key: 'a', label: 'Public credit in front of leadership' },
      { key: 'b', label: 'A quiet thank-you from the people you helped' },
    ],
    facetIds: ['self_enhancement', 'self_transcendence'],
  },
  {
    itemKey: 'reserve.v1/lost_wallet',
    type: 'choice',
    domain: 'casual',
    prompt: 'You lose $50 and find $50 on the same day. How do you feel by evening?',
    options: [
      { key: 'a', label: 'Even, it balanced out' },
      { key: 'b', label: 'Still annoyed about the loss' },
      { key: 'c', label: 'Happy about the find' },
    ],
    facetIds: ['loss_aversion', 'emotional_stability'],
  },
  {
    itemKey: 'reserve.v1/morning',
    type: 'score',
    domain: 'casual',
    prompt: 'How similar are your weekday mornings to each other?',
    options: [
      { key: '0', label: 'Never the same' },
      { key: '1', label: 'Mostly different' },
      { key: '2', label: 'Somewhat similar' },
      { key: '3', label: 'Mostly the same' },
      { key: '4', label: 'Identical routine' },
    ],
    facetIds: ['routine'],
  },
  {
    itemKey: 'reserve.v1/review_detail',
    type: 'choice',
    domain: 'professional',
    prompt: 'Reviewing a teammate’s work, what do you look at first?',
    options: [
      { key: 'a', label: 'Whether the overall approach makes sense' },
      { key: 'b', label: 'Whether the details are correct' },
    ],
    facetIds: ['detail_orientation'],
  },
  {
    itemKey: 'reserve.v1/gut_call',
    type: 'noul',
    domain: 'core',
    prompt: 'Choosing between two apartments you like equally, would you decide on gut feeling?',
    options: yn,
    facetIds: ['deliberation'],
  },
];

const letters = 'abcde';
const choice = (key: string, facetIds: string[], prompt: string, labels: string[]): ItemTemplate => ({
  itemKey: `reserve.v2/${key}`,
  type: 'choice',
  domain: 'casual',
  prompt,
  options: labels.map((label, i) => ({ key: letters[i]!, label })),
  facetIds,
});
const scale = (key: string, facetIds: string[], prompt: string, labels: string[]): ItemTemplate => ({
  itemKey: `reserve.v2/${key}`,
  type: 'score',
  domain: 'casual',
  prompt,
  options: labels.map((label, i) => ({ key: String(i), label })),
  facetIds,
});
const yesNo = (key: string, facetIds: string[], prompt: string): ItemTemplate => ({
  itemKey: `reserve.v2/${key}`,
  type: 'noul',
  domain: 'casual',
  prompt,
  options: yn,
  facetIds,
});

/**
 * Items new in reserve.v2 (ADR-0042): two concrete scenarios for every facet new in ontology v2. Each describes one
 * everyday situation and offers actions, not self-descriptions. Sensitive items ask plainly, presume nothing and
 * cover the whole range; they are served only to people who consented to the area (ADR-0040).
 */
export const RESERVE_V2_NEW: ItemTemplate[] = [
  // Emotion and motivation
  choice(
    'emotion_regulation_1',
    ['emotion_regulation'],
    'Someone makes a harsh comment about something you worked hard on. What do you do for the next hour?',
    [
      'Keep going and hide that it stung',
      'Replay it in my head',
      'Tell myself it is one opinion and move on',
    ],
  ),
  choice(
    'emotion_regulation_2',
    ['emotion_regulation'],
    'Your flight is cancelled and you will arrive a day late. Which is closest to what you do?',
    [
      'Stay annoyed about it for a while',
      'Swallow the frustration and sort it out',
      'Treat the extra day as a bonus',
    ],
  ),
  choice(
    'emotional_expressiveness_1',
    ['emotional_expressiveness'],
    'You get great news during dinner with friends. What happens next?',
    ['I share it right away, beaming', 'I mention it with a smile', 'I keep it to myself for now'],
  ),
  choice(
    'emotional_expressiveness_2',
    ['emotional_expressiveness'],
    'A film you are watching with others really moves you. What do they see?',
    ['Nothing, I keep a straight face', 'A small reaction', 'Tears or laughter, openly'],
  ),
  scale(
    'punishment_sensitivity_1',
    ['punishment_sensitivity'],
    'You send a message with an embarrassing typo to a big group chat. What happens next?',
    [
      'I forget it straight away',
      'I wince, then forget it',
      'I think about it a few times that day',
      'I send a correction and still dwell on it',
      'It stays on my mind for days',
    ],
  ),
  choice(
    'punishment_sensitivity_2',
    ['punishment_sensitivity'],
    'A friend asks you to give a short toast at their wedding. What is your first thought?',
    ['What if I mess it up', 'This could be fun', 'Neither, I just start preparing'],
  ),
  choice(
    'reward_sensitivity_1',
    ['reward_sensitivity'],
    'A friend invites you to a last-minute concert tonight, but you planned a quiet night in. What do you do?',
    ['Go, it sounds exciting', 'Go only if it is a band I love', 'Stay in as planned'],
  ),
  scale(
    'reward_sensitivity_2',
    ['reward_sensitivity'],
    'You are one level away from a reward in a game or app. What do you do?',
    [
      'Ignore it',
      'Try once if it is easy',
      'Give it a few goes',
      'Keep trying until I get it',
      'Stay up late to get it',
    ],
  ),
  choice('need_for_cognition_1', ['need_for_cognition'], 'On a free evening, which would you rather do?', [
    'Work through a puzzle that takes real thought',
    'Watch something easy to switch off with',
  ]),
  choice(
    'need_for_cognition_2',
    ['need_for_cognition'],
    'A friend explains a tricky idea you only half follow. What do you do?',
    ['Ask questions until I really get it', 'Nod and look it up later', 'Let it go'],
  ),
  choice(
    'growth_mindset_1',
    ['growth_mindset'],
    'At your first dance class you are clearly the worst in the room. What do you do the next week?',
    ['Go back, I will get better', 'Try a class that suits me more', 'Stop, it is not for me'],
  ),
  choice(
    'growth_mindset_2',
    ['growth_mindset'],
    'A friend says they are just bad with numbers, so they will never learn to do their own budget. What do you tell them?',
    ['Anyone can learn it with practice', 'Some people are not numbers people'],
  ),
  choice(
    'self_control_1',
    ['self_control'],
    'You decided to skip dessert this week. At dinner, your favourite cake arrives. What do you do?',
    ['Skip it', 'Have one small bite', 'Have a slice and start again tomorrow'],
  ),
  choice(
    'self_control_2',
    ['self_control'],
    'It is late, you must be up early, and a new episode of a show you love just came out. What do you do?',
    ['Go to bed and watch it tomorrow', 'Watch one, then bed', 'Watch until the season is done'],
  ),
  // Values and morality
  choice(
    'care_harm_1',
    ['care_harm'],
    'You see a stray dog limping in the rain and you are already late. What do you do?',
    ['Stop and help, even if I am late', 'Call a shelter as I keep walking', 'Keep going'],
  ),
  yesNo(
    'care_harm_2',
    ['care_harm'],
    'Would you tell a very funny story at a party if it would embarrass a friend who is not there?',
  ),
  choice(
    'fairness_cheating_1',
    ['fairness_cheating'],
    'A friend running a raffle offers to slip your ticket to the top of the draw. What do you do?',
    ['Refuse, it would not be fair', 'Laugh it off and let them decide', 'Accept, it is only a raffle'],
  ),
  choice(
    'fairness_cheating_2',
    ['fairness_cheating'],
    'You and a friend share a taxi, and you ride twice as far. How do you split the fare?',
    ['I pay more, by distance', 'We split it evenly', 'Whoever pays, pays'],
  ),
  choice(
    'loyalty_betrayal_1',
    ['loyalty_betrayal'],
    "Your friend's café is not as good as the new one across the street. Where do you usually go?",
    ["My friend's, always", "Mostly my friend's", 'Whichever is better that day'],
  ),
  choice(
    'loyalty_betrayal_2',
    ['loyalty_betrayal'],
    'Your best friend is in a dispute with someone you both know, and your friend is partly wrong. What do you do?',
    [
      'Back my friend, in public and in private',
      'Back them in public, tell them the truth in private',
      'Side with whoever is more right',
    ],
  ),
  choice(
    'authority_subversion_1',
    ['authority_subversion'],
    'At a family gathering, the eldest relative insists on a tradition you find outdated. What do you do?',
    ['Go along with it out of respect', 'Go along, and say what I think later', 'Openly skip it'],
  ),
  choice(
    'authority_subversion_2',
    ['authority_subversion'],
    'A building manager tells everyone to clear the lobby now, without saying why. What do you do?',
    ['Leave right away', 'Ask why, then leave', 'Stay until I get a reason'],
  ),
  choice(
    'liberty_oppression_1',
    ['liberty_oppression'],
    'Your town wants to ban fireworks for everyone because a few people misuse them. Where do you stand?',
    ['For the ban', 'Against it, punish only the misusers', 'I do not mind either way'],
  ),
  yesNo(
    'liberty_oppression_2',
    ['liberty_oppression'],
    'Your building offers a door app that logs who comes and goes, for safety. Would you vote to install it?',
  ),
  choice(
    'honesty_humility_1',
    ['honesty_humility'],
    'A cashier gives you $20 too much change and is already serving the next customer. What do you do?',
    ['Go back and return it', 'Return it only if it is easy', 'Keep it'],
  ),
  choice(
    'honesty_humility_2',
    ['honesty_humility'],
    'You are selling your old bike online, and it has a fault a buyer would not spot. What do you do?',
    ['Mention it and lower the price', 'Mention it only if asked', 'Say nothing'],
  ),
  choice(
    'norm_compliance_1',
    ['norm_compliance'],
    'It is 2 a.m., the street is empty, and the pedestrian light is red. What do you do?',
    ['Wait for the green light', 'Cross if it is clearly safe'],
  ),
  choice(
    'norm_compliance_2',
    ['norm_compliance'],
    "You're walking a friend's dog in a park where dogs must stay on the leash, and nobody else is around. What do you do?",
    ['Keep the leash on', 'Let it off for a minute', 'Let it run'],
  ),
  // Beliefs and worldview
  choice(
    'locus_of_control_1',
    ['locus_of_control'],
    'You did not get a flat you applied for. What is your first explanation?',
    ['I should have applied differently', 'The landlord had someone in mind', 'Just bad luck'],
  ),
  choice(
    'locus_of_control_2',
    ['locus_of_control'],
    'Your team loses a pub quiz by one point. What do you put it down to?',
    ['Things we could have done better', 'Unfair questions', 'The luck of the draw'],
  ),
  choice(
    'optimism_1',
    ['optimism'],
    'You are waiting to hear back about something you really want, like a flat or a place on a course. What do you expect?',
    ['I will probably get it', 'It could go either way', 'I probably will not'],
  ),
  choice(
    'optimism_2',
    ['optimism'],
    'You are planning an outdoor party three weeks away. What do you plan for?',
    [
      'Sunshine, and deal with rain if it comes',
      'Book a tent just in case',
      'Plan it indoors, it will probably rain',
    ],
  ),
  choice(
    'just_world_1',
    ['just_world'],
    'You read that a stranger lost their savings in an online scam. What is your first thought?',
    ['They should have been more careful', 'That could happen to anyone'],
  ),
  choice(
    'just_world_2',
    ['just_world'],
    'Someone who never prepares gets top marks in a course you both take. What do you think?',
    ['It will catch up with them eventually', 'Life is not always fair', 'Good for them'],
  ),
  // Beliefs and worldview: politics and religion (sensitive, consented only)
  scale(
    'political_leaning_1',
    ['political_leaning'],
    'In a close national election, which kind of party would you most likely vote for?',
    ['Clearly left of centre', 'Centre-left', 'Centre', 'Centre-right', 'Clearly right of centre'],
  ),
  choice(
    'political_leaning_2',
    ['political_leaning'],
    'Your city must choose: lower taxes with fewer public services, or higher taxes with more. Which do you back?',
    ['Lower taxes, fewer services', 'Keep things as they are', 'Higher taxes, more services'],
  ),
  scale('political_engagement_1', ['political_engagement'], 'An election is coming up. What do you do?', [
    'I usually do not vote',
    'I vote, nothing more',
    'I vote and follow the news',
    'I vote and talk it over with people',
    'I volunteer, donate or campaign',
  ]),
  choice(
    'political_engagement_2',
    ['political_engagement'],
    'A friend shares a petition on a local issue you agree with. What do you do?',
    ['Nothing', 'Sign it', 'Sign and share it', 'Sign, share and go to the public meeting'],
  ),
  scale(
    'religiosity_1',
    ['religiosity'],
    'In a typical month, how many times do you attend a religious service or set time aside to pray?',
    ['Never', 'Once or less', 'Two or three times', 'About weekly', 'Most days'],
  ),
  choice(
    'religiosity_2',
    ['religiosity'],
    'Facing a big decision, like moving to a new city, what part does religious faith play?',
    ['None, I am not religious', 'A small part', 'An important part', 'It guides the decision'],
  ),
  choice(
    'spirituality_1',
    ['spirituality'],
    'Standing under a clear night sky far from any city, which is closest to what you feel?',
    ['Awe at nature and science', 'A sense of something greater', 'Not much, it is just the sky'],
  ),
  choice(
    'spirituality_2',
    ['spirituality'],
    'A friend says everything happens for a reason. What do you say?',
    ['I believe that too', 'Maybe, sometimes', 'I think things just happen'],
  ),
  // Relationships and intimacy
  choice(
    'attachment_anxiety_1',
    ['attachment_anxiety'],
    'Someone close to you has not replied to your message all day. What goes through your mind?',
    ['They are busy, no worries', 'I wonder a little', 'I worry something is wrong between us'],
  ),
  choice(
    'attachment_anxiety_2',
    ['attachment_anxiety'],
    'A close friend cancels your plans twice in a row. What do you think?',
    ['Life is busy, no big deal', 'I wonder if something is up', 'I worry they are pulling away from me'],
  ),
  choice('attachment_avoidance_1', ['attachment_avoidance'], 'You are having a hard week. What do you do?', [
    'Lean on someone close',
    'Mention it, but mostly handle it myself',
    'Handle it alone',
  ]),
  choice(
    'attachment_avoidance_2',
    ['attachment_avoidance'],
    'Someone you have grown close to wants to see you every weekend. What is your reaction?',
    ['Great, I would like that', 'Nice, but I need some weekends to myself', 'It feels like too much'],
  ),
  choice(
    'social_comparison_1',
    ['social_comparison'],
    'A friend posts about a promotion and a new car. What do you do?',
    [
      'Congratulate them and move on',
      'Congratulate them, then think about where I stand',
      'Feel behind for a while',
    ],
  ),
  choice(
    'social_comparison_2',
    ['social_comparison'],
    'You get your score back from a course or a fitness test. What do you want to know next?',
    ['Nothing, my score is enough', 'How it compares to the average', 'Exactly where I ranked'],
  ),
  choice(
    'forgiveness_1',
    ['forgiveness'],
    'A friend forgot your birthday and apologised a week later. What do you do?',
    ['Forgive it right away', 'Forgive it, but I remember', 'Stay cool with them for a while'],
  ),
  choice(
    'forgiveness_2',
    ['forgiveness'],
    'A neighbour damaged your fence, paid for the repair, but never apologised. How do you treat them?',
    ['Same as before', 'Polite but distant', 'I avoid them'],
  ),
  // Relationships and intimacy: sexuality (sensitive, consented only)
  yesNo(
    'sociosexuality_1',
    ['sociosexuality'],
    'Could you enjoy sex with someone you are attracted to without being in a relationship with them?',
  ),
  choice(
    'sociosexuality_2',
    ['sociosexuality'],
    'Before becoming intimate with someone new, how well do you want to know them?',
    [
      'Very well, in a committed relationship',
      'Well, after several dates',
      'A little, after a date or two',
      'Mutual attraction is enough',
    ],
  ),
  choice(
    'relationship_exclusivity_1',
    ['relationship_exclusivity'],
    'If a partner suggested opening up your relationship, what would you do?',
    ['Say no, I want us to be exclusive', 'Talk it through before deciding', 'Be open to it'],
  ),
  choice(
    'relationship_exclusivity_2',
    ['relationship_exclusivity'],
    'A friend says they are happy in a relationship with two partners. What is your honest reaction?',
    ['Not for me', 'Not for me, but I get it', 'I could imagine it for myself'],
  ),
  // Everyday and health (sensitive, consented only)
  choice(
    'health_vigilance_1',
    ['health_vigilance'],
    'You notice a new ache that has lasted a week but is not getting worse. What do you do?',
    ['Wait and see', 'Look it up online', "Book a doctor's appointment"],
  ),
  choice(
    'health_vigilance_2',
    ['health_vigilance'],
    'Your phone offers to track your sleep, steps and heart rate every day. What do you do?',
    ['Turn it on and check it daily', 'Turn it on and glance now and then', 'Leave it off'],
  ),
  choice(
    'body_image_1',
    ['body_image'],
    'You catch your reflection in a shop window on an ordinary day. What is your usual reaction?',
    ['Happy with what I see', 'Neutral or mixed', 'Mostly critical'],
  ),
  choice('body_image_2', ['body_image'], 'Friends invite you for a day at the beach. How do you get ready?', [
    'Wear what I like without a thought',
    'Take a while choosing what to wear',
    'Cover up, or find a reason to skip it',
  ]),
  choice(
    'substance_use_1',
    ['substance_use'],
    'At a relaxed dinner with friends, what do you usually drink?',
    ['No alcohol', 'One drink', 'Two or three', 'More than three'],
  ),
  choice(
    'substance_use_2',
    ['substance_use'],
    'Where it is legal, someone at a party offers you cannabis. What do you do?',
    ['Decline, I do not use it', 'Try a little', 'Accept, I use it now and then'],
  ),
  // Money
  choice(
    'mental_accounting_1',
    ['mental_accounting'],
    'You get an unexpected $200 tax refund. What do you do with it?',
    ['Treat myself, it is bonus money', 'Put it toward bills or savings', 'Some of each'],
  ),
  yesNo(
    'mental_accounting_2',
    ['mental_accounting'],
    'You lose your $50 concert ticket on the way to the show. Would you buy another at the door?',
  ),
  choice('materialism_1', ['materialism'], 'You have $500 to spend on yourself. What do you choose?', [
    'Something nice I can keep',
    'A trip or an experience',
  ]),
  choice('materialism_2', ['materialism'], 'A friend buys an expensive designer watch. What do you think?', [
    'Nice, I would like one too',
    'Nice, but not for me',
    'A waste of money',
  ]),
  // Money in detail (sensitive, consented only)
  choice(
    'financial_security_1',
    ['financial_security'],
    'An unexpected $1,000 bill arrives. How would you cover it?',
    [
      'From savings, easily',
      'From savings, but it would hurt',
      'Borrow or use credit',
      'It would be very hard to cover',
    ],
  ),
  choice(
    'financial_security_2',
    ['financial_security'],
    'At the end of a typical month, where does your money stand?',
    ['Some left to save', 'About even', 'Short, and I borrow to cover it'],
  ),
  choice(
    'debt_attitude_1',
    ['debt_attitude'],
    'You want a new laptop. You can pay in 12 interest-free instalments or save for four months. What do you do?',
    ['Instalments, and get it now', 'Save, and buy it outright'],
  ),
  yesNo('debt_attitude_2', ['debt_attitude'], 'Would you take out a loan to pay for a dream holiday?'),
];

/** reserve.v2 (ADR-0042): reserve.v1, keys unchanged, plus the new items. For configs on ontology v2. */
export const RESERVE_V2: ItemTemplate[] = [...RESERVE_V1, ...RESERVE_V2_NEW];

export const RESERVE_SETS: Record<string, ItemTemplate[]> = {
  'reserve.v1': RESERVE_V1,
  'reserve.v2': RESERVE_V2,
};

export function getReserveSet(setId: string): ItemTemplate[] {
  const r = RESERVE_SETS[setId];
  if (!r) throw new Error(`Unknown reserve set: ${setId}`);
  return r;
}
