// state-pipe/serializer.js
// Pure function. Takes Owlbear scene items (from OBR.scene.items.getItems()) and
// the GM's per-round overrides (typed in the iframe panel), returns a BattleState.
// No side effects. The villain prompt builder consumes the output of this.

export const METADATA_NAMESPACE = 'com.thislittlecorner.monster-party/combatant';

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
 * @property {string[]} crystalsHeld
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
    switch (tag.role) {
      case 'pc': {
        if (!PC_NAMES.has(tag.name)) break;
        const bubbled = !!tag.bubbled;
        party.push({
          name: tag.name,
          hp: numOr(tag.hp, 0),
          maxHp: numOr(tag.maxHp, 0),
          ac: numOr(tag.ac, bubbled ? 19 : 14),
          bubbled,
          stunned: !!tag.stunned,
          actionDiceAvailable: numOr(
            tag.actionDiceAvailable,
            tag.stunned ? 0 : 4,
          ),
          specialsRemaining: numOr(tag.specialsRemaining, 2),
          crystalsHeld: Array.isArray(tag.crystalsHeld) ? tag.crystalsHeld : [],
        });
        break;
      }
      case 'boss': {
        boss = {
          hp: numOr(tag.hp, 500),
          ac: numOr(tag.ac, 14),
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
          suit: tag.suit,
          archetype: tag.archetype || 'unknown',
          hp: numOr(tag.hp, 0),
          alive: tag.alive !== false,
          cardsExhausted: Array.isArray(tag.cardsExhausted)
            ? tag.cardsExhausted
            : [],
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
