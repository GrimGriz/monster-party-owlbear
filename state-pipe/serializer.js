// state-pipe/serializer.js
// Pure function. Takes Owlbear scene items (from OBR.scene.items.getItems()) and
// the GM's per-round overrides (typed in the iframe panel), returns a BattleState.
// No side effects. The villain prompt builder consumes the output of this.

export const METADATA_NAMESPACE = 'com.thislittlecorner.monster-party/combatant';
// Lucas's Stat Bubbles extension. We read HP / max HP / specials-remaining
// from this namespace as the canonical source; our own tag stays
// identity-only. The keys have literal spaces in them — that's the shape
// Stat Bubbles writes, not a typo.
//   health           — current HP
//   max health       — max HP
//   temporary health — specials remaining (Griz's reuse)
//   armor class      — level indicator (Griz's reuse) — IGNORED here; our
//                      combat AC is hardcoded bubbled?19:14 per mechanics.
//   hide             — Stat Bubbles' visibility toggle, do not touch
export const STAT_BUBBLES_NAMESPACE = 'com.owlbear-rodeo-bubbles-extension/metadata';

/**
 * @typedef {Object} PCState
 * @property {'Denny'|'Beholda'|'Rascal'|'Goose'} name
 * @property {number} hp
 * @property {number} maxHp
 * @property {number} ac
 * @property {boolean} bubbled
 * @property {boolean} stunned
 * @property {number} actionDiceAvailable
 * @property {number} specialsRemaining
 */

/**
 * @typedef {Object} BossState
 * @property {number} hp
 * @property {number} ac
 * @property {string[]} cardsExhausted
 * @property {string|false} tauntedTo
 */

/**
 * @typedef {Object} LackeyState
 * @property {string} id
 * @property {'CONTROL'|'EMOTION'|'ASPIRATION'|'EXTRACTION'} suit
 * @property {string} archetype
 * @property {number} hp
 * @property {boolean} alive
 * @property {string[]} cardsExhausted
 */

/**
 * @typedef {Object} BattleState
 * @property {number} round
 * @property {PCState[]} party
 * @property {BossState|null} boss
 * @property {LackeyState[]} lackeys
 * @property {string|null} bonusDieWinner
 * @property {number} rescuedMemberEmojiCount
 */

const PC_NAMES = new Set(['Denny', 'Beholda', 'Rascal', 'Goose']);

export function serializeScene(obrItems, gmOverrides = {}) {
  const tagged = (obrItems || [])
    .map((item) => ({ item, tag: item?.metadata?.[METADATA_NAMESPACE] }))
    .filter((entry) => entry.tag && entry.tag.role);

  const party = [];
  let boss = null;
  const lackeys = [];

  for (const { item, tag } of tagged) {
    const sb = item?.metadata?.[STAT_BUBBLES_NAMESPACE] || {};
    switch (tag.role) {
      case 'pc': {
        if (!PC_NAMES.has(tag.name)) break;
        const bubbled = !!tag.bubbled;
        party.push({
          name: tag.name,
          hp: numOr(sb.health, numOr(tag.hp, 0)),
          maxHp: numOr(sb['max health'], numOr(tag.maxHp, 0)),
          ac: bubbled ? 19 : 14,
          bubbled,
          stunned: !!tag.stunned,
          actionDiceAvailable: numOr(
            tag.actionDiceAvailable,
            tag.stunned ? 0 : 4,
          ),
          specialsRemaining: numOr(sb['temporary health'], numOr(tag.specialsRemaining, 2)),
        });
        break;
      }
      case 'boss': {
        const acReduction = numOr(tag.acReduction, 0);
        boss = {
          hp: numOr(sb.health, numOr(tag.hp, 500)),
          // Base AC 14 minus cumulative Baleful Gaze contributions. Floored
          // at 0 by the setter; floored again here so a corrupted tag can't
          // push AC negative.
          ac: Math.max(0, 14 - Math.max(0, acReduction)),
          acReduction: Math.max(0, acReduction),
          cardsExhausted: Array.isArray(tag.cardsExhausted)
            ? tag.cardsExhausted
            : [],
          tauntedTo: tag.tauntedTo || false,
        };
        break;
      }
      case 'lackey': {
        lackeys.push({
          id: tag.id || item.id,
          // suit: null means non-card-user (soda monster, generic mid-fight
          // mook). The lackey row UI defaults to Basic-only when suit is
          // null OR specialsRemaining is 0.
          suit: tag.suit || null,
          archetype: tag.archetype || 'unknown',
          hp: numOr(sb.health, numOr(tag.hp, 0)),
          alive: tag.alive !== false,
          // Lackey specials remaining lives in Stat Bubbles' 'temporary
          // health' (same reuse as PCs). When 0 (or suit null), lackey is
          // basic-only per battle-info §6.
          specialsRemaining: numOr(sb['temporary health'], 0),
          // Per-archetype basic atk damage. Defaults to 15 for legacy
          // entries without a basicDmg field (the influencer lackeys
          // pre-r10). New mid-fight subminions are seeded from the
          // LACKEY_REGISTRY or the prompt-for-unknown path.
          basicDmg: numOr(tag.basicDmg, 15),
          cardsExhausted: Array.isArray(tag.cardsExhausted)
            ? tag.cardsExhausted
            : [],
          // tauntedTo: set by Denny's Taunt extension (each die-success
          // adds one more enemy to the taunt). When 'Denny', this lackey's
          // next attack MUST target her.
          tauntedTo: tag.tauntedTo || false,
        });
        break;
      }
    }
  }

  party.sort(
    (a, b) =>
      ['Denny', 'Beholda', 'Rascal', 'Goose'].indexOf(a.name) -
      ['Denny', 'Beholda', 'Rascal', 'Goose'].indexOf(b.name),
  );

  return {
    round: numOr(gmOverrides.round, 1),
    party,
    boss,
    lackeys,
    bonusDieWinner: gmOverrides.bonusDieWinner ?? null,
    rescuedMemberEmojiCount: numOr(gmOverrides.rescuedMemberEmojiCount, 0),
  };
}

function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function applyVillainMove(/* scene, move */) {
  // v1: GM types new HP after a card resolves. Auto-application is a v2 nice-to-have.
  throw new Error('NOT IMPLEMENTED — v1 keeps HP updates manual');
}
