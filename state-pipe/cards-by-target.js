// state-pipe/cards-by-target.js
// Derived deck for the Monster Party boss fight. Joins the source deck
// (villain-deck-source.js) with the per-suit/target mechanics from
// mechanics-audit-2026-05-18.md §5.
//
// Per-card fields actually used in the fight: suit, name, archetype, mechanic
// (kept for villain context), targetHero, targetSave, baseDC, fullDmg, halfDmg,
// replyHooks (where documented in sample-cards.md, otherwise empty — villain
// improvises per "one per suit, four-card chain" rule).
//
// What's intentionally NOT joined in: naming-tax word (card-game only),
// truth-bomb (flavor, not mechanically load-bearing here), [TOPIC] LARP slot
// (boss fight's topic is fixed — the stream itself).

export const SUIT_BINDING = {
  CONTROL: { color: 'red', save: 'Social', hero: 'Rascal', baseDC: 11, fullDmg: 14, halfDmg: 7 },
  EMOTION: { color: 'orange', save: 'Heart', hero: 'Goose', baseDC: 10, fullDmg: 12, halfDmg: 6 },
  ASPIRATION: { color: 'gold', save: 'Survival', hero: 'Denny', baseDC: 13, fullDmg: 22, halfDmg: 11 },
  EXTRACTION: { color: 'purple', save: 'Wisdom', hero: 'Beholda', baseDC: 12, fullDmg: 16, halfDmg: 8 },
};

// Per-card overrides for the 6 cards documented in sample-cards.md.
// Anything not in this map gets baseDC from SUIT_BINDING and empty replyHooks.
const CARD_OVERRIDES = {
  RAGE:    { replyHooks: ['CONFORM', 'TRIBE', 'SILENCE', 'DISGUST', 'DOOM'] },
  CONFORM: { replyHooks: ['VIRTUE', 'TRIBE', 'SILENCE', 'AUTHORITY'] },
  FOMO:    { replyHooks: ['GLOW', 'FLEX', 'HOPIUM', 'OPTIMIZE'] },
  HOPIUM:  { replyHooks: ['OPTIMIZE', 'GLOW', 'VIRTUE', 'SLEEP'] },
  NUMB:    { replyHooks: ['COPE', 'SLEEP', 'PARASOCIAL', 'CONSUME'] },
};

const SOURCE = [
  // CONTROL → Rascal (Social)
  { suit: 'CONTROL', name: 'OBEY',      archetype: 'Generic Authority Enforcement',
    mechanic: "Short-circuits critical evaluation by substituting status for substance. You don't assess the claim — you assess the claimant's right to make it." },
  { suit: 'CONTROL', name: 'TRIBE',     archetype: 'Binary Tribalism Engine',
    mechanic: "Engagement is driven by affiliation signaling, not information processing. Sharing = declaring allegiance." },
  { suit: 'CONTROL', name: 'VIRTUE',    archetype: 'Moral Performance Display',
    mechanic: "Social reward for stated values without behavioral cost. The cause becomes a stage prop for identity maintenance." },
  { suit: 'CONTROL', name: 'AUTHORITY', archetype: 'Expert Theater',
    mechanic: "Asymmetric legibility: the poster performs knowing while the reader performs learning. The thread is a leash." },
  { suit: 'CONTROL', name: 'CONFORM',   archetype: 'Manufactured Consensus',
    mechanic: "Replaces individual evaluation with crowd signal. The viral metric substitutes for truth-testing." },
  { suit: 'CONTROL', name: 'SILENCE',   archetype: 'Censorship Narrative Engine',
    mechanic: "Sharing becomes rebellion. If you don't engage, 'they' won. Virality framed as moral imperative." },

  // EMOTION → Goose (Heart)
  { suit: 'EMOTION', name: 'RAGE',     archetype: 'Outrage Bait Engine',
    mechanic: "Anger increases sharing velocity and decreases critical evaluation. Physiological arousal makes you act before thinking." },
  { suit: 'EMOTION', name: 'FEAR',     archetype: 'Ambient Threat Loop',
    mechanic: "Uncertainty sustains attention. The amygdala hijack keeps you scrolling for resolution the feed never provides." },
  { suit: 'EMOTION', name: 'ENVY',     archetype: 'Comparison Engine',
    mechanic: "Upward social comparison triggers inadequacy without naming it. The product they sell is the solution to the problem the post created." },
  { suit: 'EMOTION', name: 'WEEP',     archetype: 'Sentimentality Weapon',
    mechanic: "Sentimentality short-circuits analysis the same way rage does, but the arousal is warmth instead of heat." },
  { suit: 'EMOTION', name: 'DOOM',     archetype: 'Nihilism Engine',
    mechanic: "Paralysis disguised as awareness. If nothing can be done, scrolling isn't avoidance — it's acceptance." },
  { suit: 'EMOTION', name: 'DISGUST',  archetype: 'Purity/Contamination Frame',
    mechanic: "Purity intuitions bypass the prefrontal cortex entirely — you recoil, then rationalize." },

  // ASPIRATION → Denny (Survival)
  { suit: 'ASPIRATION', name: 'GRIND',    archetype: 'Hustle Gospel',
    mechanic: "Internalizes systemic pressure as individual choice. Rest becomes moral failure. The poster's visible suffering is the credential." },
  { suit: 'ASPIRATION', name: 'FLEX',     archetype: 'Status Display',
    mechanic: "Status display creates implicit ranking. The audience sorts itself relative to the poster." },
  { suit: 'ASPIRATION', name: 'FOMO',     archetype: 'Manufactured Urgency',
    mechanic: "Artificial time pressure collapses deliberation. You act to avoid missing out, not because you've evaluated." },
  { suit: 'ASPIRATION', name: 'HOPIUM',   archetype: 'Magical Thinking Engine',
    mechanic: "Magical thinking prevents structural critique. Personal responsibility is totalized — your suffering is your frequency." },
  { suit: 'ASPIRATION', name: 'OPTIMIZE', archetype: 'Quantified Self Capture',
    mechanic: "Self-surveillance rebranded as empowerment. The tracking creates a new inadequacy: you're not just living wrong, you're measuring wrong." },
  { suit: 'ASPIRATION', name: 'GLOW',     archetype: 'Transformation Narrative',
    mechanic: "Transformation narratives compress time and erase cost. The 'before' is always worse; the 'after' is aspirational. The middle is invisible." },

  // EXTRACTION → Beholda (Wisdom) — chain-extender, primary bubble-pop suit
  { suit: 'EXTRACTION', name: 'CONSUME',    archetype: 'Pure Attention Extraction',
    mechanic: "Attention is extracted without providing value. The content is designed to be consumed, not remembered." },
  { suit: 'EXTRACTION', name: 'SLEEP',      archetype: 'Pacification Mantra',
    mechanic: "Parasocial comfort replaces actual rest. The imperative mood disguised as permission. Action replaced by feeling-about-action." },
  { suit: 'EXTRACTION', name: 'NUMB',       archetype: 'Cognitive White Noise',
    mechanic: "Occupies cognitive bandwidth without engaging it. Filler between RAGE and FEAR spikes that prevents emotional fatigue from closing the app." },
  { suit: 'EXTRACTION', name: 'COPE',       archetype: 'Dysfunction Normalization',
    mechanic: "Normalizes distress as identity rather than signal. If everyone feels this way, it's not a problem to solve — it's a community to join." },
  { suit: 'EXTRACTION', name: 'PARASOCIAL', archetype: 'Intimacy Simulation',
    mechanic: "One-directional intimacy replaces community. The follower provides attention and money; the creator provides the simulation of being known." },
  { suit: 'EXTRACTION', name: 'NOSTALGIA',  archetype: 'Temporal Identity Capture',
    mechanic: "The past is reconstructed as a lost golden age. The present becomes intolerable, which drives more scrolling." },
];

export const CARDS = SOURCE.map((card) => {
  const binding = SUIT_BINDING[card.suit];
  const override = CARD_OVERRIDES[card.name] || {};
  return {
    ...card,
    targetHero: binding.hero,
    targetSave: binding.save,
    baseDC: binding.baseDC,
    fullDmg: binding.fullDmg,
    halfDmg: binding.halfDmg,
    replyHooks: override.replyHooks || [],
  };
});

export const BY_SUIT = {
  CONTROL: CARDS.filter((c) => c.suit === 'CONTROL'),
  EMOTION: CARDS.filter((c) => c.suit === 'EMOTION'),
  ASPIRATION: CARDS.filter((c) => c.suit === 'ASPIRATION'),
  EXTRACTION: CARDS.filter((c) => c.suit === 'EXTRACTION'),
};

export const BY_TARGET = {
  Denny: BY_SUIT.ASPIRATION,
  Beholda: BY_SUIT.EXTRACTION,
  Rascal: BY_SUIT.CONTROL,
  Goose: BY_SUIT.EMOTION,
};

export function availableCardsForSuit(suit, exhausted = []) {
  const exhaustedSet = new Set(exhausted);
  return (BY_SUIT[suit] || []).filter((c) => !exhaustedSet.has(c.name));
}
