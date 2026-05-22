// extension-iframe/app.js
// GM panel. Loads inside OBR as an action-mode iframe, or standalone in a
// browser tab for dev. Wires:
//   - live BattleState (from OBR scene metadata + GM overrides)
//   - context-menu items to tag tokens
//   - Generate 4-card chain → Anthropic API → render w/ save-fail buttons
//   - chain resolution writes back to token metadata + history (localStorage)

import OBR from 'https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm';
import {
  serializeScene,
  METADATA_NAMESPACE,
  STAT_BUBBLES_NAMESPACE,
} from '../state-pipe/serializer.js';
import { SUIT_BINDING, BY_SUIT, availableCardsForSuit, CARDS } from '../state-pipe/cards-by-target.js';
import {
  buildVillainPrompt,
  parseVillainResponse,
} from '../state-pipe/prompt-builder.js';

const $ = (id) => document.getElementById(id);

const PC_ROSTER = ['Denny', 'Beholda', 'Rascal', 'Goose'];
const CRYSTAL_COLORS = ['Green', 'Yellow', 'Indigo'];
const STORAGE_KEYS = {
  apiKey: 'mp-villain.apiKey',
  model: 'mp-villain.model',
  overrides: 'mp-villain.gmOverrides',
  history: 'mp-villain.history',
  pendingChain: 'mp-villain.pendingChain',
  currentRound: 'mp-villain.currentRound',
  pendingInterrupt: 'mp-villain.pendingInterrupt',
};

// Locked boss-fight specials per PC (mechanics-audit-2026-05-18 §2 / battle-info §2).
// `target` controls how the action picks a target:
//   'pick'    — uses the PC card's target dropdown selection
//   'pick-pc' — uses the dropdown but expects a PC name (heals / share)
//   'party'   — fixed to "Party", dropdown ignored
//   'boss'    — fixed to "Algorithm" (boss), dropdown ignored
//   'self'    — fixed to the PC themselves
// `sideEffect` is dispatched in dispatchSideEffect() — taunt, bubble, fireball-trigger, etc.
//
// `formula` is the L4 damage/heal computation per battle-info §2:
//   amount = base + mul * successes  (base applied only iff successes >= 1)
//   kind = 'damage' subtracts HP; 'heal' adds HP.
//   partyWide = true → apply to every alive PC (Goose Group Heal).
// Actions with no formula (VNA Bubble, Dice-Share, Taunt's bonus targets)
// are pure-effect logs; they don't write HP per success.
const PC_ACTIONS = {
  Denny: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick',
      formula: { base: 0, mul: 10, kind: 'damage' } },
    // Taunt — pick any enemy (lackey or boss). The picked enemy gets
    // tauntedTo='Denny'; each REAL die-success extends the taunt to one
    // more enemy (proximity order if available; lackey-first → boss
    // fallback otherwise). Damage always lands on Algorithm: cast = +20
    // ("free success"), each real success = +20 more. presetSuccesses=1
    // baseline so the row's ×1 reflects the free success.
    { id: 'taunt',  label: 'Taunt',         isSpecial: true,  target: 'pick', sideEffect: 'taunt',
      formula: { base: 0, mul: 20, kind: 'damage', forceTarget: 'Algorithm' } },
    { id: 'denim',  label: 'Denim Damage',  isSpecial: true,  target: 'pick',
      formula: { base: 35, mul: 15, kind: 'damage' } },
  ],
  Beholda: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick',
      formula: { base: 0, mul: 10, kind: 'damage' } },
    { id: 'vna',    label: 'VNA Bubble',    isSpecial: true,  target: 'party', sideEffect: 'bubble' },
    // Baleful Gaze — base 40 dmg + 10/success vs Algorithm. Each success
    // ALSO reduces boss AC by 1 (cumulative across rounds). The "every
    // -1 def becomes 10 dmg" comment was the prior surprise mechanic;
    // Griz's 5/21 spec stacks both: deal damage AND reduce defense.
    { id: 'gaze',   label: 'Baleful Gaze',  isSpecial: true,  target: 'boss', sideEffect: 'gaze',
      formula: { base: 40, mul: 10, kind: 'damage' } },
  ],
  Rascal: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick',
      formula: { base: 0, mul: 10, kind: 'damage' } },
    { id: 'fire',   label: 'Range Fireball', isSpecial: true, target: 'pick', sideEffect: 'fireball',
      formula: { base: 30, mul: 10, kind: 'damage' } },
    { id: 'share',  label: 'Dice-Share',    isSpecial: true,  target: 'pick-pc' },
  ],
  Goose: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick',
      formula: { base: 0, mul: 10, kind: 'damage' } },
    { id: 'group',  label: 'Group Heal',    isSpecial: true,  target: 'party',
      formula: { base: 20, mul: 5, kind: 'heal', partyWide: true } },
    { id: 'single', label: 'Single Heal',   isSpecial: true,  target: 'pick-pc',
      formula: { base: 25, mul: 15, kind: 'heal' } },
  ],
};

function emptyHeroPhase() {
  return { pcActions: [], crystalsUsed: [], notes: [] };
}

function emptyCurrentRound() {
  return {
    phase: 'party',
    heroPhase: emptyHeroPhase(),
    lackeyAttacks: [],
  };
}

const state = {
  inOwlbear: false,
  items: [],
  overrides: loadOverrides(),
  history: loadHistory(),
  pendingChain: loadPendingChain(),
  pendingInterrupt: loadPendingInterrupt(),
  currentRound: loadCurrentRound(),
};

// Expose for in-browser debugging. Read-only convention — mutating from the
// console will not survive an onChange refresh in OBR mode.
if (typeof window !== 'undefined') window._mp = { state };

let unsubscribeItems = null;

// Catch any error that escapes a try/catch so we can see its actual shape.
// OBR rejects with plain objects ({code, message, ...}); a default browser console
// renders these as just "Object" which is useless. Stringify the own properties.
function stringifyErr(err) {
  if (!err) return String(err);
  if (typeof err === 'string') return err;
  try {
    const keys = Object.getOwnPropertyNames(err);
    const out = {};
    for (const k of keys) out[k] = err[k];
    return JSON.stringify(out);
  } catch (_) {
    return String(err);
  }
}
window.addEventListener('error', (e) => {
  console.error('[MP] window.error', stringifyErr(e.error || e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[MP] unhandledrejection', stringifyErr(e.reason));
});

// Build tag — log at boot so we can verify the right bundle loaded inside
// OBR's iframe (browser may serve a cached app.js when Ctrl+Shift+R reloads
// OBR's outer page without busting the iframe's cache).
const BUILD_TAG = '2026-05-22-interrupt-r11';

main();

async function main() {
  console.log(`[MP] app.js bundle: ${BUILD_TAG} (loaded ${new Date().toISOString()})`);
  hydrateSettings();
  hydrateOverridesUi();
  bindUi();

  state.inOwlbear = isInsideOwlbear();
  if (state.inOwlbear) {
    log('Owlbear SDK detected. Waiting for onReady…');
    OBR.onReady(onOwlbearReady);
  } else {
    log('Standalone mode (no OBR host). Rendering mock scene.');
    state.items = mockSceneItems();
    renderAll();
  }
}

function isInsideOwlbear() {
  try {
    return typeof OBR?.isAvailable === 'boolean' ? OBR.isAvailable : false;
  } catch (_) {
    return false;
  }
}

async function onOwlbearReady() {
  log('OBR ready.');
  try {
    const role = await OBR.player.getRole();
    if (role !== 'GM') {
      renderErrorBanner(
        'This panel is GM-only. Ask the GM to open the Villain Claude action.',
      );
      return;
    }
  } catch (err) {
    log(`player.getRole failed: ${err?.message || err}`);
  }

  // Context menu doesn't depend on scene-ready — register once at SDK-ready.
  try {
    console.log('[MP] step: registerTokenTaggingMenu');
    await registerTokenTaggingMenu();
  } catch (err) {
    console.error('[MP] registerTokenTaggingMenu failed:', stringifyErr(err));
  }

  // Scene-dependent work (getItems, render, onChange subscribe) waits for
  // scene-ready. OBR.onReady fires when the iframe is mounted, but the actual
  // scene metadata may not be loaded yet — getItems errors with
  // MissingDataError until OBR.scene.isReady() returns true.
  let sceneReady = false;
  try {
    sceneReady = await OBR.scene.isReady();
  } catch (err) {
    console.error('[MP] scene.isReady failed:', stringifyErr(err));
  }
  console.log(`[MP] scene.isReady() = ${sceneReady}`);
  if (sceneReady) await initSceneState();

  // Re-init on scene-switch / late scene-load.
  try {
    OBR.scene.onReadyChange(async (ready) => {
      console.log(`[MP] scene.onReadyChange: ready=${ready}`);
      if (ready) await initSceneState();
    });
  } catch (err) {
    console.error('[MP] scene.onReadyChange subscribe failed:', stringifyErr(err));
  }

  window.addEventListener('beforeunload', () => {
    if (unsubscribeItems) unsubscribeItems();
  });
}

async function initSceneState() {
  // Clean up any prior items subscription before re-subscribing (scene-switch path).
  if (unsubscribeItems) {
    try { unsubscribeItems(); } catch (_) {}
    unsubscribeItems = null;
  }

  try {
    console.log('[MP] step: getItems (scene ready)');
    state.items = await OBR.scene.items.getItems();
  } catch (err) {
    console.error('[MP] getItems failed:', stringifyErr(err));
    state.items = [];
  }

  const tagged = state.items.filter((i) => i?.metadata?.[METADATA_NAMESPACE]);
  console.log(
    `[MP] init: items=${state.items.length} tagged=${tagged.length}` +
      (tagged.length
        ? ' tags=[' + tagged.map((i) => i.metadata[METADATA_NAMESPACE].role + ':' + (i.metadata[METADATA_NAMESPACE].name || i.metadata[METADATA_NAMESPACE].archetype || 'boss')).join(',') + ']'
        : ''),
  );

  // Detailed dump: log first ~3 items' type+layer so we can see what the scene actually has.
  for (const it of state.items.slice(0, 5)) {
    console.log('[MP] item sample:', JSON.stringify({ id: it.id, type: it.type, layer: it.layer, name: it.name, hasMeta: !!it?.metadata?.[METADATA_NAMESPACE] }));
  }

  // Full metadata namespace dump for the first 3 tagged items. Used to identify
  // other extensions' namespaces (notably Stat Bubbles' HP shape) so we can
  // optionally read/write to them. Strip after Stat Bubbles integration ships.
  for (const it of tagged.slice(0, 3)) dumpItemMetadata(it);

  try {
    renderAll();
  } catch (err) {
    console.error('[MP] renderAll failed:', stringifyErr(err));
  }

  try {
    unsubscribeItems = OBR.scene.items.onChange((items) => {
      state.items = items;
      try { renderAll(); } catch (err) { console.error('[MP] onChange renderAll:', stringifyErr(err)); }
    });
  } catch (err) {
    console.error('[MP] onChange subscribe failed:', stringifyErr(err));
  }
}

function dumpItemMetadata(it) {
  const ns = it?.metadata ? Object.keys(it.metadata) : [];
  console.log(`[MP] tagged-meta ${it.name || it.id} namespaces: [${ns.join(', ')}]`);
  for (const key of ns) {
    console.log(`  ${key} =`, JSON.stringify(it.metadata[key]));
  }
}

// ----- Token tagging context menu -----

// Menu ids registered by prior builds of this extension. OBR persists menu
// registrations in session state across iframe reloads, so removing entries
// from our code alone leaves the old ones lingering in the right-click menu.
// Explicitly unregister them before creating the new single-entry menu.
const OLD_MENU_IDS = [
  'mp-tag-pc-denny',
  'mp-tag-pc-beholda',
  'mp-tag-pc-rascal',
  'mp-tag-pc-goose',
  'mp-tag-boss',
  'mp-tag-lackey-aspiration',
  'mp-tag-lackey-extraction',
  'mp-tag-lackey-emotion',
  'mp-tag-lackey-control',
  'mp-untag',
  'mp-remove',
];

async function registerTokenTaggingMenu() {
  // Tear down any context-menu items persisted by older builds before we
  // register the current set. Errors per-id are non-fatal — the id may not
  // exist on a fresh install.
  for (const oldId of OLD_MENU_IDS) {
    try {
      await OBR.contextMenu.remove(oldId);
      console.log(`[MP] removed stale menu id: ${oldId}`);
    } catch (_) {
      // Not registered (fresh install or already cleaned) — fine.
    }
  }

  // Single entry. Remove-from-extension lives on the panel rows (right-click
  // a PC/boss/lackey row in the panel) — keeps the OBR right-click menu lean
  // and puts the destructive action where the tagged items are visible.
  try {
    await OBR.contextMenu.create({
      id: 'mp-add',
      icons: [
        {
          icon: 'https://grimgriz.github.io/monster-party-owlbear/extension-iframe/action-icon.svg',
          label: 'Monster Party: Add to extension',
          // every: [{ layer: CHARACTER }] restricts the menu to actual character tokens.
          // Stat-Bubbles overlays are on non-CHARACTER layers (PROP/ATTACHMENT/NOTE),
          // so without this filter the right-click can land on a bubble and tag the
          // wrong item — serializer then never finds a PC.
          filter: {
            roles: ['GM'],
            every: [{ key: 'layer', value: 'CHARACTER' }],
          },
        },
      ],
      onClick: (context) => handleAddClick(context.items || []),
    });
  } catch (err) {
    console.error(`[MP] contextMenu.create(mp-add) failed:`, stringifyErr(err));
    log(`contextMenu.create(mp-add) failed: ${err?.message || err}`);
  }
}

// Auto-detect role from BOTH the OBR item's asset name (item.name — the
// uploaded filename / asset label) AND its visible text overlay
// (item.text.plainText — what Griz edits via right-click → Edit Text).
// Either matching is enough, so a Monk-asset token labelled "Denny" works,
// AND a token already named "Piratebeholda" works. Substring match,
// case-insensitive. Returns the tag to write, or null if no rule fires.
// Registry of known lackey archetypes. Matched by substring against the
// token's asset name + text overlay. Used by autoDetectRoleFromItem on the
// "Add to extension" right-click. Order matters — more-specific matchers
// first so e.g. "Alex Jones-Bot" hits the Alex-Jones entry before any
// generic fallback. Adding a new archetype: push an entry here.
//
// suit: null → non-card-user (no Save/Fail mechanic, only Basic atk).
//              Forced SP=0 at default; the lackey-row UI's outOfSp branch
//              renders Basic-only.
// basicDmg:  damage on a Basic attack (replaces the legacy hardcoded 15).
const LACKEY_REGISTRY = [
  // Card-using influencer lackeys (battle-info §6).
  { match: (h) => h.includes('alex') && h.includes('jones'),
    archetype: 'Alex-Jones-Bot', suit: 'EMOTION', hp: 50, sp: 2, basicDmg: 10 },
  { match: (h) => h.includes('hasan') && h.includes('piker'),
    archetype: 'Hasan-Piker-Bot', suit: 'CONTROL', hp: 50, sp: 2, basicDmg: 10 },
  { match: (h) => h.includes('aspiration'),
    archetype: 'ASPIRATION lackey', suit: 'ASPIRATION', hp: 50, sp: 2, basicDmg: 10 },
  { match: (h) => h.includes('extraction'),
    archetype: 'EXTRACTION lackey', suit: 'EXTRACTION', hp: 50, sp: 2, basicDmg: 10 },
  // Non-card-using mooks (battle-info §6 + 5-21-encounter-design.md §3).
  // Soda monsters: ~30 HP, ranged 10 dmg, AoE special (special not modelled
  // in v1 — GM resolves narratively if used).
  { match: (h) => h.includes('soda'),
    archetype: 'Soda Monster', suit: null, hp: 30, sp: 0, basicDmg: 10 },
  // Baked potatoes: tier-1 mook, ~15 HP, 10 dmg.
  { match: (h) => h.includes('potato'),
    archetype: 'Baked Potato', suit: null, hp: 15, sp: 0, basicDmg: 10 },
];

function lackeyTagFromRegistry(entry) {
  return {
    role: 'lackey',
    suit: entry.suit, // null for non-card-users — serializer surfaces as-is
    archetype: entry.archetype,
    alive: true,
    cardsExhausted: [],
    basicDmg: entry.basicDmg,
    // Stat Bubbles will get hp/sp written on the tag-write path (see
    // writeTagToSelection's STAT_BUBBLES_NAMESPACE handling).
  };
}

function autoDetectRoleFromItem(item) {
  const haystack = [
    item?.name || '',
    item?.text?.plainText || '',
  ].join(' ').toLowerCase();
  if (!haystack.trim()) return null;

  // PCs — substring lets "Piratebeholda" / "Monk-Denny" / etc. match.
  if (haystack.includes('denny'))   return defaultPcTag('Denny');
  if (haystack.includes('beholda')) return defaultPcTag('Beholda');
  if (haystack.includes('rascal'))  return defaultPcTag('Rascal');
  if (haystack.includes('goose'))   return defaultPcTag('Goose');

  // Boss
  if (haystack.includes('algorithm') || haystack.includes('villain') || haystack.trim() === 'boss') {
    return { role: 'boss', cardsExhausted: [], tauntedTo: false };
  }

  // Lackeys — walk the registry.
  for (const entry of LACKEY_REGISTRY) {
    if (entry.match(haystack)) return lackeyTagFromRegistry(entry);
  }

  // Crystals — three colors per battle-info §5. Match on color + "crystal"
  // so a token labelled "Green Crystal" or "Yellow crystal" or "indigo-crystal"
  // all land. Tagging makes the matching slot in the hero-phase strip clickable.
  if (haystack.includes('crystal')) {
    if (haystack.includes('green'))  return { role: 'crystal', color: 'Green', used: false };
    if (haystack.includes('yellow')) return { role: 'crystal', color: 'Yellow', used: false };
    if (haystack.includes('indigo')) return { role: 'crystal', color: 'Indigo', used: false };
  }

  return null;
}

// Fallback when autoDetect returns null — prompt the GM for a generic lackey
// shape (HP + basic dmg). Used for mid-fight subminion adds that aren't in
// the registry. Returns a tag (and HP/SP for Stat Bubbles) or null on cancel.
function promptForGenericLackey(displayName) {
  const input = prompt(
    `Token "${displayName}" didn't match a known archetype. Tag as a generic lackey?\n\n` +
    `Enter: HP, basic-dmg\n(e.g. "30,10"). Cancel to skip.`,
    '30,10',
  );
  if (input == null) return null;
  const [hpStr, dmgStr] = input.split(',').map((s) => s.trim());
  const hp = parseInt(hpStr, 10);
  const dmg = parseInt(dmgStr, 10);
  if (!Number.isFinite(hp) || hp <= 0) return null;
  const basicDmg = Number.isFinite(dmg) && dmg > 0 ? dmg : 10;
  return {
    tag: {
      role: 'lackey',
      suit: null, // non-card-user
      archetype: displayName || 'Lackey',
      alive: true,
      cardsExhausted: [],
      basicDmg,
    },
    hp,
    sp: 0,
  };
}

async function handleAddClick(items) {
  if (!items.length) {
    console.log('[MP] mp-add click → no items selected');
    return;
  }
  for (const item of items) {
    const assetName = item?.name || '';
    const textName = item?.text?.plainText || '';
    let tag = autoDetectRoleFromItem(item);
    let seed = null;
    if (!tag) {
      // No registry match — prompt the GM for a generic lackey (mid-fight
      // subminions Griz drops in on the fly). Cancel skips this token.
      const generic = promptForGenericLackey(textName || assetName || 'token');
      if (!generic) {
        console.warn(
          `[MP] mp-add: no match + no manual tag for asset="${assetName}" text="${textName}" (id=${item.id}). ` +
          `Skipped.`,
        );
        continue;
      }
      tag = generic.tag;
      seed = { hp: generic.hp, sp: generic.sp };
    } else if (tag.role === 'lackey') {
      // Registry-known lackey — pull its HP/SP defaults so writeTagToSelection
      // can seed Stat Bubbles when the GM hasn't set those up on the token.
      const entry = LACKEY_REGISTRY.find((e) => e.archetype === tag.archetype);
      if (entry) seed = { hp: entry.hp, sp: entry.sp };
    }
    console.log(`[MP] mp-add: asset="${assetName}" text="${textName}" → ${tag.role}:${tag.name || tag.archetype || 'boss'}${seed ? ` (seed HP=${seed.hp} SP=${seed.sp})` : ''}`);
    await writeTagToSelection([item], tag, seed);
  }
}

// Remove handler triggered by right-click on a panel row. Confirms before
// destroying the tag (since this drops the role assignment, not the token).
async function removeTagFromItem(itemId, displayLabel) {
  if (!itemId) return;
  if (!confirm(`Remove ${displayLabel} from Monster Party extension?`)) return;
  const item = state.items.find((it) => it.id === itemId);
  if (!item) {
    console.warn(`[MP] remove: item ${itemId} not in state.items — re-fetching scene…`);
    try {
      const fresh = await OBR.scene.items.getItems([itemId]);
      if (fresh.length) await writeTagToSelection(fresh, null);
    } catch (err) {
      console.error('[MP] remove fallback fetch failed:', stringifyErr(err));
    }
    return;
  }
  console.log(`[MP] remove: "${item.name}" (id=${itemId})`);
  await writeTagToSelection([item], null);
}

// Lookup helpers so panel rows can find their OBR item id.
function findItemByPcName(name) {
  return state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    return tag?.role === 'pc' && tag?.name === name;
  });
}
function findBossItem() {
  return state.items.find((it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss');
}
function findLackeyItemByTagId(tagId) {
  return state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    if (tag?.role !== 'lackey') return false;
    return (tag.id || it.id) === tagId;
  });
}

function defaultPcTag(name) {
  // PC tag is identity + ephemeral combat flags only. HP / max HP / specials
  // remaining come from Stat Bubbles' metadata namespace (see serializer).
  // AC is hardcoded bubbled?19:14 in the serializer per locked mechanics.
  return {
    role: 'pc', name,
    bubbled: false, stunned: false,
    actionDiceAvailable: 4,
  };
}

async function writeTagToSelection(items, tag, seed = null) {
  if (!items?.length) return;
  const ids = items.map((it) => it.id);
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      if (tag === null) {
        delete draft.metadata[METADATA_NAMESPACE];
      } else {
        draft.metadata[METADATA_NAMESPACE] = tag;
        // Optional seed for Stat Bubbles HP/SP — only writes if the token
        // doesn't already have these set (so we don't clobber a GM-configured
        // bubble). Used for mid-fight subminion adds where the token hasn't
        // had Stat Bubbles set up yet.
        if (seed) {
          const sb = draft.metadata[STAT_BUBBLES_NAMESPACE] || {};
          if (typeof sb.health !== 'number' && typeof seed.hp === 'number') {
            sb.health = seed.hp;
          }
          if (typeof sb['max health'] !== 'number' && typeof seed.hp === 'number') {
            sb['max health'] = seed.hp;
          }
          if (typeof sb['temporary health'] !== 'number' && typeof seed.sp === 'number') {
            sb['temporary health'] = seed.sp;
          }
          draft.metadata[STAT_BUBBLES_NAMESPACE] = sb;
        }
      }
    }
  });

  // Post-tag diagnostic: re-fetch the touched items and dump their full
  // metadata (all namespaces). This is how we identify other extensions'
  // namespaces — notably Stat Bubbles — for the optional HP read/write
  // integration. Fires reliably even when init's getItems lost the
  // MissingDataError race.
  try {
    const fresh = await OBR.scene.items.getItems(ids);
    for (const it of fresh) dumpItemMetadata(it);
  } catch (err) {
    console.error('[MP] post-tag dump failed:', stringifyErr(err));
  }
}

// ----- UI binding -----

function bindUi() {
  // (API-key Settings UI removed in r9 — voice-paste workflow replaces the
  // API call. The API key/model storage keys remain in STORAGE_KEYS for
  // backward compat if a future build wants to restore the API path.)

  $('ov-round').addEventListener('change', (e) => {
    state.overrides.round = parseInt(e.target.value, 10) || 1;
    saveOverrides();
    renderAll();
  });
  $('ov-bonus-die').addEventListener('change', (e) => {
    state.overrides.bonusDieWinner = e.target.value || null;
    saveOverrides();
    renderAll();
  });
  $('ov-rescued').addEventListener('change', (e) => {
    state.overrides.rescuedMemberEmojiCount = parseInt(e.target.value, 10) || 0;
    saveOverrides();
    renderAll();
  });

  $('end-hero-turn').addEventListener('click', endHeroTurn);
  $('reset-hero-phase').addEventListener('click', () => {
    if (!confirm('Reset this round\'s hero phase (clears logged actions & crystals, returns phase to Party)?')) return;
    state.currentRound = emptyCurrentRound();
    saveCurrentRound();
    renderAll();
  });

  for (const color of CRYSTAL_COLORS) {
    const slot = document.getElementById(`crystal-slot-${color.toLowerCase()}`);
    if (slot) slot.addEventListener('click', () => onCrystalSlotClick(color));
  }

  $('copy-battle-info').addEventListener('click', copyBattleInfoToClipboard);
  $('copy-system-prompt').addEventListener('click', copySystemPromptToClipboard);
  $('log-voice-chain').addEventListener('click', logChainFromVoiceSummary);
  $('clear-chain').addEventListener('click', () => {
    state.pendingChain = null;
    savePendingChain();
    renderChain();
  });
  $('end-round').addEventListener('click', endRound);
  $('copy-history').addEventListener('click', copyHistoryToClipboard);
  $('clear-history').addEventListener('click', () => {
    if (!confirm('Clear all combat history?')) return;
    state.history = [];
    saveHistory();
    renderHistory();
  });
}

function hydrateSettings() {
  // No-op since the API-key Settings UI was removed in r9. Stub kept so
  // initial bootstrap order in init() doesn't break. Voice-paste workflow
  // needs no per-user settings state.
}

function hydrateOverridesUi() {
  $('ov-round').value = state.overrides.round ?? 1;
  $('ov-bonus-die').value = state.overrides.bonusDieWinner ?? '';
  $('ov-rescued').value = state.overrides.rescuedMemberEmojiCount ?? 0;
}

// ----- Render -----

function currentBattleState() {
  return serializeScene(state.items, state.overrides);
}

function renderAll() {
  renderToolbar();
  renderState();
  renderHeroPhase();
  renderLackeyAttacksBlock();
  renderInterrupt();
  renderChain();
  renderHistory();
  renderRoundFinalizeVisibility();
  applyPhaseGating();
}

function renderToolbar() {
  const round = state.overrides.round ?? 1;
  const roundEl = $('toolbar-round');
  if (roundEl) roundEl.textContent = round;
  const pill = $('phase-pill');
  if (!pill) return;
  const phase = state.currentRound.phase === 'villain' ? 'Villain' : 'Party';
  pill.classList.toggle('villain', phase === 'Villain');
  pill.innerHTML = `Phase: <b>${phase}</b>`;
}

function applyPhaseGating() {
  const heroSec = $('hero-phase');
  const villainSec = $('villain-turn');
  if (!heroSec || !villainSec) return;
  const isVillain = state.currentRound.phase === 'villain';
  heroSec.classList.toggle('inactive', isVillain);
  villainSec.classList.toggle('inactive', !isVillain);
}

// ----- Hero phase rendering -----

function renderHeroPhase() {
  const bs = currentBattleState();
  const root = $('hero-pcs');
  if (!root) return;
  root.innerHTML = '';

  const partyByName = Object.fromEntries((bs.party || []).map((pc) => [pc.name, pc]));
  const aliveEnemies = enemyTargetOptions(bs);
  const heroPhaseEnded = state.currentRound.phase === 'villain';
  const actedSet = new Set(
    (state.currentRound.heroPhase.pcActions || [])
      .filter((a) => !a.action?.endsWith?.('(AoE)')) // AoE extras don't mark the PC as acted again
      .map((a) => a.pc),
  );

  for (const pcName of PC_ROSTER) {
    const pc = partyByName[pcName];
    if (!pc) continue; // not tagged; skip
    const card = document.createElement('div');
    const dead = pc.hp <= 0;
    const stunned = !!pc.stunned;
    const acted = actedSet.has(pcName);
    const classes = ['hero-pc', pcName.toLowerCase()];
    if (dead) classes.push('dead');
    else if (stunned) classes.push('stunned');
    if (acted) classes.push('acted');
    card.className = classes.join(' ');

    const specials = pc.specialsRemaining ?? 0;
    const spDots = Array.from({ length: 2 }, (_, i) =>
      `<span class="${i < specials ? '' : 'spent'}">●</span>`,
    ).join('');

    const flagBits = [];
    if (pc.bubbled) flagBits.push('BUBBLED');
    if (stunned) flagBits.push('STUNNED');
    if (dead) flagBits.push('DOWN');

    const targetOptions = [
      ...aliveEnemies.map((e) => `<option value="${escapeAttr(e.name)}">${escapeHtml(e.name)}</option>`),
      `<option value="Party">Party</option>`,
      ...PC_ROSTER
        .filter((n) => partyByName[n])
        .map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`),
    ].join('');

    const actionsHtml = PC_ACTIONS[pcName].map((act) => {
      const isSp = act.isSpecial;
      const disabled = dead || stunned || heroPhaseEnded || acted || (isSp && specials < 1);
      const cls = `${isSp ? 'special' : ''}`;
      return `<button class="${cls}" data-act="${act.id}" ${disabled ? 'disabled' : ''}>${escapeHtml(act.label)}${isSp ? ` (SP)` : ''}</button>`;
    }).join('');

    card.innerHTML = `
      <h4>
        <span>${escapeHtml(pcName)}</span>
        <span class="pc-stats">${pc.hp}/${pc.maxHp} HP · AC ${pc.ac} · <span class="sp-dots">${spDots}</span></span>
      </h4>
      <div class="pc-stats">${flagBits.join(' · ') || '&nbsp;'}</div>
      <div class="target-row">
        <label>Target:</label>
        <select data-target-pick>${targetOptions}</select>
      </div>
      <div class="actions">${actionsHtml}</div>
    `;

    card.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actId = btn.getAttribute('data-act');
        const action = PC_ACTIONS[pcName].find((a) => a.id === actId);
        const targetSel = card.querySelector('select[data-target-pick]');
        const pickedTarget = targetSel ? targetSel.value : '';
        onPcActionClick(pcName, action, pickedTarget).catch((err) =>
          log(`hero action failed: ${err?.message || err}`),
        );
      });
    });

    root.appendChild(card);
  }

  renderCrystalSlots(bs);
  renderHeroActionsLog();
}

function enemyTargetOptions(bs) {
  const opts = [];
  if (bs.boss) opts.push({ name: 'Algorithm', kind: 'boss' });
  for (const l of bs.lackeys || []) {
    if (l.alive) opts.push({ name: l.archetype, kind: 'lackey', suit: l.suit });
  }
  return opts;
}

function renderCrystalSlots(bs) {
  // Walk tagged crystal items; mark each color's slot as available / used / absent.
  const tagged = (state.items || [])
    .map((it) => ({ item: it, tag: it?.metadata?.[METADATA_NAMESPACE] }))
    .filter((e) => e.tag?.role === 'crystal');
  const byColor = {};
  for (const { tag } of tagged) {
    if (CRYSTAL_COLORS.includes(tag.color)) byColor[tag.color] = tag;
  }
  // Anything we've logged in this round counts as used too (in case the OBR write hasn't landed).
  const usedThisRound = new Set((state.currentRound.heroPhase.crystalsUsed || []).map((c) => c.color));

  for (const color of CRYSTAL_COLORS) {
    const slot = document.getElementById(`crystal-slot-${color.toLowerCase()}`);
    if (!slot) continue;
    slot.className = 'crystal-slot';
    slot.removeAttribute('title');
    const tag = byColor[color];
    if (!tag) {
      slot.title = `No ${color} crystal in play — tag a token in OBR to activate this slot.`;
      slot.textContent = color[0];
      continue;
    }
    const used = tag.used || usedThisRound.has(color);
    slot.classList.add(used ? 'used' : 'available', color.toLowerCase());
    slot.title = used
      ? `${color} crystal already used.`
      : `Click to log: Party used the ${color} crystal.`;
    slot.textContent = color[0];
  }
}

function renderHeroActionsLog() {
  const root = $('hero-actions-log');
  if (!root) return;
  root.innerHTML = '';
  const actions = state.currentRound.heroPhase.pcActions || [];
  const crystals = state.currentRound.heroPhase.crystalsUsed || [];
  const notes = state.currentRound.heroPhase.notes || [];
  if (!actions.length && !crystals.length && !notes.length) {
    root.innerHTML = '<div class="empty">No hero actions logged yet this round.</div>';
    return;
  }

  // Render actions with success counter where the formula warrants one.
  actions.forEach((a, idx) => {
    const row = document.createElement('div');
    row.className = 'entry';
    const formula = a.formula;
    const targetTxt = a.target ? ` → ${escapeHtml(a.target)}` : '';
    const noteTxt = a.note ? ` (${escapeHtml(a.note)})` : '';
    const counterHtml = formula
      ? `<span class="success-counter" data-idx="${idx}">
           <button class="step" data-step="-1" title="Decrement successes">−</button>
           <span class="count">${a.successes || 0}</span>
           <button class="step" data-step="+1" title="Increment successes">+</button>
           <span class="applied">${formatAppliedAmount(formula, a.appliedAmount || 0)}</span>
         </span>`
      : '';
    row.innerHTML = `
      <span class="who">${escapeHtml(a.pc)}</span>
      <span class="what">${escapeHtml(a.action)}${targetTxt}${noteTxt}</span>
      ${counterHtml}
      <button class="x" title="Remove (refunds SP, reverses HP)">×</button>
    `;
    row.querySelector('button.x').addEventListener('click', () => {
      removeHeroPhaseEntry('action', idx);
    });
    row.querySelectorAll('button.step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = parseInt(btn.getAttribute('data-step'), 10);
        adjustActionSuccesses(idx, step).catch((err) =>
          log(`adjust failed: ${err?.message || err}`),
        );
      });
    });
    root.appendChild(row);

    // Inline AoE picker — appears under each Range Fireball PRIMARY entry
    // (sideEffect='fireball'; AoE extras have sideEffect=null and so don't
    // get one). Lists in-range enemies not already part of the AoE; clicking
    // + adds a new AoE entry with successes copied from the primary's
    // current count (so HP applies in step with what the GM has rolled).
    if (a.sideEffect === 'fireball') {
      const aoeChips = renderAoePickerChips(idx);
      if (aoeChips) root.appendChild(aoeChips);
    }
  });

  crystals.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <span class="who">Crystal</span>
      <span class="what">${escapeHtml(c.color)} used${c.note ? ` — ${escapeHtml(c.note)}` : ''}</span>
      <button class="x" title="Remove">×</button>
    `;
    row.querySelector('button.x').addEventListener('click', () => removeHeroPhaseEntry('crystal', idx));
    root.appendChild(row);
  });

  notes.forEach((n, idx) => {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <span class="who">GM</span>
      <span class="what">${escapeHtml(n)}</span>
      <button class="x" title="Remove">×</button>
    `;
    row.querySelector('button.x').addEventListener('click', () => removeHeroPhaseEntry('note', idx));
    root.appendChild(row);
  });
}

function formatAppliedAmount(formula, amt) {
  if (!amt) return '';
  if (formula.partyWide) {
    return `(${amt}/PC ${formula.kind})`;
  }
  return `(${amt} ${formula.kind})`;
}

// Build the inline AoE picker DOM for the Fireball primary entry at index
// `primaryIdx`. Returns null if no candidates remain. Each chip is a button
// labeled "+ <enemy>" — clicking it spawns a new AoE entry mirroring the
// primary's pc / formula / successes so the new target's HP applies at the
// same damage as what's already been counted.
function renderAoePickerChips(primaryIdx) {
  const primary = state.currentRound.heroPhase.pcActions[primaryIdx];
  if (!primary) return null;
  const bs = currentBattleState();
  const enemies = enemyTargetOptions(bs).map((e) => e.name);
  // Exclude the primary's own target and any enemies already represented in
  // the AoE (other fire-actionId entries for the same pc in this round).
  const inAoeAlready = new Set(
    (state.currentRound.heroPhase.pcActions || [])
      .filter((a) => a.actionId === 'fire' && a.pc === primary.pc)
      .map((a) => a.target),
  );
  const candidates = enemies.filter((n) => !inAoeAlready.has(n));
  if (!candidates.length) return null;

  const wrap = document.createElement('div');
  wrap.className = 'aoe-picker';
  wrap.innerHTML = `<span class="muted" style="font-size: 11px;">+ to add to AoE:</span>`;
  for (const enemy of candidates) {
    const chip = document.createElement('button');
    chip.className = 'aoe-chip ghost';
    chip.style.cssText = 'font-size: 11px; padding: 2px 8px; margin-left: 4px;';
    chip.textContent = `+ ${enemy}`;
    chip.addEventListener('click', () => {
      addAoeTarget(primaryIdx, enemy).catch((err) =>
        log(`add AoE target failed: ${err?.message || err}`),
      );
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

// Push a new AoE-extra action entry for `enemyName`, with successes copied
// from the primary so HP applies at the same damage. The new entry has
// sideEffect=null and isSpecial=false (the AoE doesn't re-consume SP).
async function addAoeTarget(primaryIdx, enemyName) {
  const primary = state.currentRound.heroPhase.pcActions[primaryIdx];
  if (!primary) return;
  const successes = primary.successes || 0;
  const appliedAmount = computeFormulaAmount(primary.formula, successes);
  const newEntry = {
    pc: primary.pc,
    action: `${primary.action.replace(/ \(AoE\)$/, '')} (AoE)`,
    actionId: primary.actionId,
    target: enemyName,
    note: '',
    successes,
    appliedAmount,
    formula: primary.formula || null,
    isSpecial: false,
    sideEffect: null,
    sideEffectExtra: null,
    tauntExtras: null,
  };
  state.currentRound.heroPhase.pcActions.push(newEntry);
  saveCurrentRound();
  renderAll();
  // Apply HP delta for the new target if any damage has been counted.
  if (appliedAmount > 0 && newEntry.formula) {
    await applyFormulaDelta(enemyName, newEntry.formula, appliedAmount);
    renderAll();
  }
  // If the new target is the boss, re-sync rascalExtraCards AND emit the
  // [TRIGGER] note (once per round) so the villain Claude sees the interrupt
  // in its next-round history even if the primary wasn't the boss.
  if (enemyName === 'Algorithm') {
    const hasTrigger = (state.currentRound.heroPhase.notes || []).some((n) =>
      n.startsWith('[TRIGGER] Rascal fireballed the Algorithm'),
    );
    if (!hasTrigger) {
      state.currentRound.heroPhase.notes.push(
        `[TRIGGER] Rascal fireballed the Algorithm — algo reacts (interrupt). ` +
        `Hero phase continues for unstunned PCs. +N extra cards next round (N = die-successes on the cast).`,
      );
      saveCurrentRound();
      renderAll();
    }
    // Spawn the interrupt UI (idempotent — only one per round).
    ensureInterruptForThisRound();
    await syncRascalExtraCards().catch((err) =>
      log(`rascalExtraCards sync failed: ${err?.message || err}`),
    );
  }
}

async function adjustActionSuccesses(idx, delta) {
  const entry = state.currentRound.heroPhase.pcActions[idx];
  if (!entry) return;
  const newSuccesses = Math.max(0, (entry.successes || 0) + delta);
  if (newSuccesses === (entry.successes || 0)) return;
  const newAmount = computeFormulaAmount(entry.formula, newSuccesses);
  const oldAmount = entry.appliedAmount || 0;
  const deltaAmount = newAmount - oldAmount;
  // Update bookkeeping SYNC before awaiting the OBR write, otherwise rapid +
  // clicks would all read the same oldAmount=0 baseline and over-apply.
  entry.successes = newSuccesses;
  entry.appliedAmount = newAmount;
  saveCurrentRound();
  renderAll();
  if (deltaAmount !== 0 && entry.formula) {
    await applyFormulaDelta(entry.target, entry.formula, deltaAmount);
    // Re-render after the HP write lands (standalone mutates state.items in
    // place; OBR mode will also trigger renderAll via onChange).
    renderAll();
  }
  // Side-effect: fireball-at-Algorithm success ticks drive rascalExtraCards
  // (the +N extra cards the villain plays next round). Surfaced to the
  // villain via heroNotes [TRIGGER] entry + hero-action ×N line.
  if (entry.actionId === 'fire') {
    await syncRascalExtraCards().catch((err) =>
      log(`rascalExtraCards sync failed: ${err?.message || err}`),
    );
  }
  // Side-effect: Taunt extension — length of tauntExtras tracks successes.
  // On +tick, add the next candidate enemy and tag tauntedTo='Denny'. On
  // -tick, pop the last and clear its tauntedTo. Idempotent across the
  // floor (successes=0 → empty list).
  if (entry.sideEffect === 'taunt') {
    await syncTauntExtras(entry, newSuccesses).catch((err) =>
      log(`taunt extension sync failed: ${err?.message || err}`),
    );
  }
  // Side-effect: Baleful Gaze AC reduction — every success on a gaze entry
  // contributes -1 to boss AC. Re-sum across history + current so the
  // metadata stays accurate after ticks.
  if (entry.actionId === 'gaze') {
    await syncBossAcReduction().catch((err) =>
      log(`boss AC sync failed: ${err?.message || err}`),
    );
  }
}

// Bring entry.tauntExtras into sync with `targetLen` (= the entry's current
// success count). Picks the next candidate enemy when extending — lackeys
// first (alive only), then Algorithm. Already-tauntExtras members and any
// dead lackey are excluded from the pool.
async function syncTauntExtras(entry, targetLen) {
  if (!entry.tauntExtras) entry.tauntExtras = [];
  const extras = entry.tauntExtras;
  // Extend.
  while (extras.length < targetLen) {
    const bs = currentBattleState();
    const taken = new Set(extras);
    const aliveLackeys = (bs.lackeys || []).filter((l) => l.alive).map((l) => l.archetype);
    const candidates = [...aliveLackeys, 'Algorithm'].filter((n) => !taken.has(n));
    if (!candidates.length) break; // no one left to taunt
    const next = candidates[0];
    extras.push(next);
    await setEnemyTauntedTo(next, 'Denny');
  }
  // Contract.
  while (extras.length > targetLen) {
    const removed = extras.pop();
    if (removed) await setEnemyTauntedTo(removed, false);
  }
  saveCurrentRound();
}

// Recompute rascalExtraCards from any current-round Range Fireball entries
// hitting Algorithm. Called from adjustActionSuccesses (tick adds successes)
// and from removeHeroPhaseEntry (× removes the entry → count drops).
async function syncRascalExtraCards() {
  const fireAtBoss = (state.currentRound.heroPhase.pcActions || [])
    .filter((e) => e.actionId === 'fire' && e.target === 'Algorithm');
  const count = fireAtBoss.reduce((max, e) => Math.max(max, e.successes || 0), 0);
  await setBossRascalExtraCards(count);
}

// Single source of truth for boss.acReduction: sum gaze successes across
// history (locked contributions) + currentRound (in-flight, tickable). Run on
// every gaze success tick AND on × removal so the metadata stays in step
// with the action log.
async function syncBossAcReduction() {
  let total = 0;
  for (const round of state.history) {
    for (const action of (round.heroActions || [])) {
      if (action.actionId === 'gaze') total += (action.successes || 0);
    }
  }
  for (const action of (state.currentRound.heroPhase.pcActions || [])) {
    if (action.actionId === 'gaze') total += (action.successes || 0);
  }
  await setBossAcReduction(total);
}

async function removeHeroPhaseEntry(kind, idx) {
  const hp = state.currentRound.heroPhase;
  if (kind === 'action') {
    const entry = hp.pcActions[idx];
    if (!entry) return;
    // 1. Reverse applied HP delta if any successes were counted.
    if (entry.appliedAmount && entry.formula) {
      try {
        await applyFormulaDelta(entry.target, entry.formula, -entry.appliedAmount);
      } catch (err) {
        log(`HP reversal failed: ${err?.message || err}`);
      }
    }
    // 2. Reverse OBR side effects (taunt / bubble). Fireball trigger is NOT
    //    reversed automatically — phase has flipped, the success-count note
    //    has been spoken, and unwinding that is more disruption than help.
    //    The GM can Reset hero phase if a fireball was a genuine misclick.
    try {
      await reverseSideEffect(entry).catch(() => {});
    } catch (_) {}
    // 3. Refund SP if this was a special.
    if (entry.isSpecial) {
      try { await changeSpecial(entry.pc, +1); } catch (err) {
        log(`SP refund failed: ${err?.message || err}`);
      }
    }
    const wasGaze = entry.actionId === 'gaze';
    hp.pcActions.splice(idx, 1);
    // Re-sync rascalExtraCards in case this was the (or one of the) fire-at-
    // Algorithm entries driving the count.
    await syncRascalExtraCards().catch((err) =>
      log(`rascalExtraCards sync failed: ${err?.message || err}`),
    );
    // Re-sync boss AC reduction if a gaze entry was removed (its successes
    // contribution should drop off).
    if (wasGaze) {
      await syncBossAcReduction().catch((err) =>
        log(`boss AC sync failed: ${err?.message || err}`),
      );
    }
  } else if (kind === 'crystal') {
    const crystal = hp.crystalsUsed[idx];
    hp.crystalsUsed.splice(idx, 1);
    if (crystal?.color) {
      try { await setCrystalUsed(crystal.color, false); } catch (err) {
        log(`crystal un-use failed: ${err?.message || err}`);
      }
    }
  } else if (kind === 'note') {
    hp.notes.splice(idx, 1);
  }
  saveCurrentRound();
  renderAll();
}

async function reverseSideEffect(entry) {
  if (!entry.sideEffect) return;
  switch (entry.sideEffect) {
    case 'taunt': {
      // Clear tauntedTo on every enemy this cast extended to (primary +
      // any successes-driven extensions). Falls back to clearing the
      // boss-only taunt for legacy entries without a tauntExtras list.
      const extras = entry.tauntExtras;
      if (Array.isArray(extras) && extras.length) {
        for (const name of extras) {
          await setEnemyTauntedTo(name, false);
        }
      } else {
        await setBossTauntedTo(false);
      }
      return;
    }
    case 'bubble':
      // VNA Bubble is the only way to set bubble in v1, so reversing is safe.
      await setAllPcsBubbled(false);
      return;
    case 'fireball':
      // Interrupt-return model: no phase flip happened at cast, and the
      // rascalExtraCards count is re-synced from remaining fire entries by
      // the caller (removeHeroPhaseEntry → syncRascalExtraCards). The
      // [TRIGGER] heroNotes entry stays as a breadcrumb of what happened
      // mid-round — the GM-typed [NOTE] below confirms the entry's removal
      // so the round's narrative reads honestly.
      state.currentRound.heroPhase.notes.push(
        `[NOTE] Rascal fireball entry removed — re-cast or use Reset hero phase if this was a misclick.`,
      );
      return;
    default:
      return;
  }
}

async function onPcActionClick(pcName, action, pickedTarget) {
  if (!action) return;
  // Resolve effective target.
  let target;
  switch (action.target) {
    case 'boss':  target = 'Algorithm'; break;
    case 'party': target = 'Party'; break;
    case 'self':  target = pcName; break;
    case 'pick':
    case 'pick-pc':
    default:      target = pickedTarget || ''; break;
  }
  if (!target) {
    log(`[hero] ${pcName} ${action.label}: no target selected`);
    return;
  }

  // Pre-action side-effects that may abort (Rascal fireball cuts the turn).
  const sideEffectResult = await dispatchSideEffect(pcName, action, target);
  if (sideEffectResult?.abort) return;

  // Log the action — bake in everything needed to reverse it later:
  // formula (so we can compute applied HP per success), the original action
  // id + sideEffect so removal can undo state writes, isSpecial so we know
  // whether to refund SP.
  const presetSuccesses = sideEffectResult?.extra?.presetSuccesses ?? 0;
  const primaryEntry = {
    pc: pcName,
    action: action.label,
    actionId: action.id,
    target,
    note: sideEffectResult?.note || '',
    successes: presetSuccesses,
    appliedAmount: 0,
    formula: action.formula || null,
    isSpecial: !!action.isSpecial,
    sideEffect: action.sideEffect || null,
    sideEffectExtra: sideEffectResult?.extra || null,
    // Taunt-specific: list of enemies currently tauntedTo='Denny' from this
    // cast. Length == successes. Per-tick adjustActionSuccesses keeps it in
    // sync; reverseSideEffect on × removal clears them all.
    tauntExtras: sideEffectResult?.extra?.tauntExtras
      ? [...sideEffectResult.extra.tauntExtras]
      : null,
  };
  state.currentRound.heroPhase.pcActions.push(primaryEntry);
  const primaryIdx = state.currentRound.heroPhase.pcActions.length - 1;

  // AoE: log additional entries for each extra target. They share the same
  // successes count and formula; SP is only consumed once (the primary).
  const extraTargets = sideEffectResult?.extra?.extraTargets || [];
  const extraIndices = [];
  for (const extraTarget of extraTargets) {
    state.currentRound.heroPhase.pcActions.push({
      pc: pcName,
      action: `${action.label} (AoE)`,
      actionId: action.id,
      target: extraTarget,
      note: '',
      successes: presetSuccesses,
      appliedAmount: 0,
      formula: action.formula || null,
      isSpecial: false,
      sideEffect: null,
      sideEffectExtra: null,
    });
    extraIndices.push(state.currentRound.heroPhase.pcActions.length - 1);
  }
  saveCurrentRound();

  // Decrement Stat Bubbles temporary health for SPs (specials remaining).
  // AoE extras don't re-consume SP.
  if (action.isSpecial) {
    try { await changeSpecial(pcName, -1); } catch (err) {
      console.error('[MP] changeSpecial(-1):', stringifyErr(err));
    }
  }

  // If preset successes > 0, auto-apply damage on every logged entry so the
  // GM doesn't have to click + N times per AoE target. The success counter
  // still works for adjustment.
  if (presetSuccesses > 0 && action.formula) {
    for (const idx of [primaryIdx, ...extraIndices]) {
      await syncActionAppliedAmount(idx).catch((err) =>
        log(`sync apply failed: ${err?.message || err}`),
      );
    }
  }

  // If the side effect forces a phase flip, do it last so the log entry above
  // is already committed. Use the shared helper so Fireball-interrupt flips
  // age stuns the same way the End Hero Turn button does.
  if (sideEffectResult?.flipToVillain) {
    await flipToVillainPhase();
  }

  renderAll();
}

// Sync an action's appliedAmount to match its current successes count, applying
// the delta to the target's HP. Used after pre-filling successes (e.g. AoE
// auto-apply).
async function syncActionAppliedAmount(idx) {
  const entry = state.currentRound.heroPhase.pcActions[idx];
  if (!entry || !entry.formula) return;
  const targetAmount = computeFormulaAmount(entry.formula, entry.successes || 0);
  const oldAmount = entry.appliedAmount || 0;
  const deltaAmount = targetAmount - oldAmount;
  if (deltaAmount !== 0) {
    entry.appliedAmount = targetAmount;
    saveCurrentRound();
    await applyFormulaDelta(entry.target, entry.formula, deltaAmount);
  }
}

async function dispatchSideEffect(pcName, action, target) {
  switch (action.sideEffect) {
    case 'taunt': {
      // Denny Taunt — primary picked-enemy gets tauntedTo='Denny' on cast.
      // Each real die-success extends the taunt to one more enemy (lackey
      // first, then boss — proximity-ordered when token positions are
      // available). Damage always lands on Algorithm: cast = +20 ("free
      // success"), each real success = +20 more. The extension list is
      // persisted on the action entry as `tauntExtras` so removal can
      // reverse all of them.
      const primary = target;
      await setEnemyTauntedTo(primary, 'Denny').catch((err) =>
        log(`taunt write failed: ${err?.message || err}`),
      );
      return {
        note: `tauntedTo Denny: ${primary} (+20 dmg algo — free success). Each die-success extends to one more enemy.`,
        extra: {
          presetSuccesses: 1, // free success — baseline 20 dmg to Algo
          tauntExtras: [primary],
        },
      };
    }
    case 'bubble': {
      // Beholda VNA Bubble — all PCs bubbled for one round (AC 14 → 19).
      await setAllPcsBubbled(true).catch((err) =>
        log(`bubble write failed: ${err?.message || err}`),
      );
      return { note: 'party AC 19 this round' };
    }
    case 'fireball': {
      // Range Fireball is ranged AoE — per battle-info §2: damage =
      // (30 + 10/success) to all in AoE radius. Successes flow through the
      // standard per-row ± counter (no upfront prompt). AoE extras are
      // added via the INLINE picker chips rendered below the primary entry
      // (see renderHeroActionsLog → renderAoePicker) so the GM gets a
      // visible candidate list with + and × per chip instead of a popup.
      //
      // The boss-hit trigger logs a [TRIGGER] note + writes rascalExtraCards
      // but does NOT cut the hero turn. Per the interrupt-return model: the
      // algorithm reacts (GM resolves narratively this turn), then remaining
      // unstunned PCs finish their hero phase, then End Hero Turn proceeds
      // normally. The +N extra cards lands on next round's villain chain.
      let triggerNote = '';
      if (target === 'Algorithm') {
        state.currentRound.heroPhase.notes.push(
          `[TRIGGER] Rascal fireballed the Algorithm — algo reacts (interrupt). ` +
          `Hero phase continues for unstunned PCs. +N extra cards next round (N = die-successes on the cast).`,
        );
        triggerNote = `→ algo interrupts, +N cards next round`;
        // Spawn the interrupt UI — auto-picks suit by current taunt state.
        ensureInterruptForThisRound();
      }

      return {
        note: `AoE${triggerNote}`,
        flipToVillain: false,
        // No AoE extras at cast time — GM adds them inline after.
        extra: { extraTargets: [], presetSuccesses: 0 },
      };
    }
    default:
      return null;
  }
}

async function onCrystalSlotClick(color) {
  // Validate the slot is actually clickable (avoid the "no token tagged" case).
  const tagged = state.items.find((it) => {
    const t = it?.metadata?.[METADATA_NAMESPACE];
    return t?.role === 'crystal' && t?.color === color;
  });
  if (!tagged) {
    log(`[crystal] ${color} not in play — tag a crystal token in OBR first.`);
    return;
  }
  const tag = tagged.metadata[METADATA_NAMESPACE];
  if (tag.used) {
    log(`[crystal] ${color} already used.`);
    return;
  }
  const already = state.currentRound.heroPhase.crystalsUsed.find((c) => c.color === color);
  if (already) return;
  const note = prompt(`Note for ${color} crystal use (optional — e.g. who got the heal, what the hivemind effect was):`, '');
  state.currentRound.heroPhase.crystalsUsed.push({ color, note: note || '' });
  saveCurrentRound();

  // Mark the OBR tag as used so the slot greys out persistently across reloads.
  try { await setCrystalUsed(color, true); } catch (err) {
    console.error('[MP] setCrystalUsed:', stringifyErr(err));
  }
  renderHeroPhase();
}

// Shared phase-flip — used by the End Hero Turn button AND by the Fireball
// interrupt (Rascal's reaction-trigger phase flip). Both are "end of hero
// phase" moments mechanically: stuns stamped in round N-1's villain phase
// have now consumed their one action and should clear, regardless of how
// the hero phase ended. Stuns NEWLY stamped during this hero phase (e.g.
// the algorithm's reaction stunning Denny/Goose mid-Fireball) carry
// stunnedAt = currentRound, so they don't clear yet — they age out at the
// end of round N+1's hero phase.
async function flipToVillainPhase() {
  try {
    await ageStunsAtRoundEnd(state.overrides.round);
  } catch (err) {
    log(`stun age failed: ${err?.message || err}`);
  }
  state.currentRound.phase = 'villain';
  saveCurrentRound();
}

async function endHeroTurn() {
  await flipToVillainPhase();
  renderAll();
}

// ----- Lackey attack rows (villain phase) -----

function renderLackeyAttacksBlock() {
  const root = $('lackey-attacks-block');
  if (!root) return;
  root.innerHTML = '';
  if (state.currentRound.phase !== 'villain') return;
  const bs = currentBattleState();
  const living = (bs.lackeys || []).filter((l) => l.alive);
  if (!living.length) return;

  const wrap = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = 'Lackey attacks';
  wrap.appendChild(heading);

  for (const l of living) {
    const idx = state.currentRound.lackeyAttacks.findIndex((la) => la.lackeyId === l.id);
    const existing = idx >= 0 ? state.currentRound.lackeyAttacks[idx] : null;
    const suitHero = (l.suit && l.suit in {EMOTION:1,CONTROL:1,ASPIRATION:1,EXTRACTION:1})
      ? ({ EMOTION: 'Goose', CONTROL: 'Rascal', ASPIRATION: 'Denny', EXTRACTION: 'Beholda' })[l.suit]
      : 'Goose';
    // Resolve the default target with precedence:
    //   1. existing.target — GM already picked something this round.
    //   2. tauntedTo — Denny's taunt forces the lackey to target her.
    //   3. villain lackeyOrder for this lackey (by archetype OR by id).
    //   4. suit-binding fallback.
    const order = (state.pendingChain?.lackeyOrders || []).find(
      (o) => o.lackeyId === l.archetype || o.lackeyId === l.id,
    );
    const villainTarget = order?.targetHero;
    const tauntForced = l.tauntedTo === 'Denny' ? 'Denny' : null;
    const defaultTarget = existing?.target || tauntForced || villainTarget || suitHero;
    const targetOptions = PC_ROSTER
      .map((n) => `<option value="${escapeAttr(n)}" ${defaultTarget === n ? 'selected' : ''}>${escapeHtml(n)}</option>`)
      .join('');

    const sp = l.specialsRemaining ?? 0;
    // suit=null → non-card-user (soda monster / generic subminion). Force
    // basic-only render regardless of SP since there's no card-suit save
    // mechanic to gate Save/Fail on.
    const outOfSp = sp <= 0 || !l.suit;
    const basicDmg = l.basicDmg ?? 15;
    const suitLabel = l.suit || 'mook';

    const row = document.createElement('div');
    row.className = 'lackey-attack-row' + (existing?.result ? ' resolved' : '');

    const tauntFlag = l.tauntedTo
      ? `<span class="error" style="font-size:10px; margin-left:6px;">TAUNTED → ${escapeHtml(l.tauntedTo)}</span>`
      : '';
    const villainIntent = order?.intent
      ? `<div class="muted" style="font-size:11px; margin-top:2px;">▸ ${escapeHtml(order.intent)}</div>`
      : '';

    if (outOfSp) {
      // Basic melee fallback per battle-info §6: 15 dmg when out of specials.
      const targetAppliedCls = existing?.mode === 'basic' ? ' resolved' : '';
      row.classList.toggle('resolved', !!existing?.result);
      const outLabel = l.suit ? 'out of SP' : 'non-card-user';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(l.archetype)}</strong>
          <span class="muted">(${escapeHtml(suitLabel)}, ${l.hp} HP, BASIC)</span>
          ${tauntFlag}
          ${villainIntent}
        </div>
        <select data-target>${targetOptions}</select>
        <button class="failed" data-result="basic"${existing?.mode === 'basic' ? ' disabled' : ''}>
          ${existing?.mode === 'basic' ? `✓ Basic ${existing.appliedHp || basicDmg}` : `Basic atk ${basicDmg}`}
        </button>
        <span class="muted" style="font-size:10px;">${outLabel}</span>
      `;
      row.querySelector('select[data-target]').addEventListener('change', (e) => {
        if (existing?.mode === 'basic') upsertLackeyAttack(l, e.target.value, 'basic', 'basic');
      });
      row.querySelector('button[data-result="basic"]').addEventListener('click', () => {
        const tgt = row.querySelector('select[data-target]').value;
        upsertLackeyAttack(l, tgt, 'basic', 'basic').catch((err) =>
          log(`lackey basic failed: ${err?.message || err}`),
        );
      });
    } else {
      // SP > 0: lackey can use its special (Save / Fail) OR the basic atk.
      // Griz wants Basic visible alongside Save/Fail so he doesn't have to
      // exhaust SP to unlock basic — same shape as the hero phase cards.
      const basicMarked = existing?.mode === 'basic';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(l.archetype)}</strong>
          <span class="muted">(${escapeHtml(suitLabel)}, ${l.hp} HP, SP ${sp})</span>
          ${tauntFlag}
          ${villainIntent}
        </div>
        <select data-target>${targetOptions}</select>
        <button class="saved" data-result="save">${existing?.result === 'save' && existing?.mode !== 'basic' ? '✓ Saved' : 'Save'}</button>
        <button class="failed" data-result="fail">${existing?.result === 'fail' && existing?.mode !== 'basic' ? '✓ Failed' : 'Fail'}</button>
        <button class="failed" data-result="basic">${basicMarked ? `✓ Basic ${existing.appliedHp || basicDmg}` : `Basic atk ${basicDmg}`}</button>
      `;
      row.querySelector('select[data-target]').addEventListener('change', (e) => {
        if (existing?.result) {
          upsertLackeyAttack(l, e.target.value, existing.result, existing.mode || 'special');
        }
      });
      row.querySelectorAll('button[data-result]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const result = btn.getAttribute('data-result');
          const tgt = row.querySelector('select[data-target]').value;
          const mode = result === 'basic' ? 'basic' : 'special';
          upsertLackeyAttack(l, tgt, result, mode).catch((err) =>
            log(`lackey attack failed: ${err?.message || err}`),
          );
        });
      });
    }
    wrap.appendChild(row);
  }
  root.appendChild(wrap);
}

async function upsertLackeyAttack(lackey, target, result, mode = 'special') {
  const idx = state.currentRound.lackeyAttacks.findIndex((la) => la.lackeyId === lackey.id);
  const prev = idx >= 0 ? state.currentRound.lackeyAttacks[idx] : null;

  // Compute the damage that goes with the new (target, result, mode).
  const binding = SUIT_BINDING[lackey.suit] || { fullDmg: 12, halfDmg: 6 };
  const basicDmg = lackey.basicDmg ?? 15;
  let newDmg = 0;
  if (mode === 'basic') newDmg = basicDmg;
  else if (result === 'save') newDmg = binding.halfDmg;
  else if (result === 'fail') newDmg = binding.fullDmg;

  // Reverse any previously-applied damage from this lackey's attack row.
  if (prev?.appliedHp && prev?.target) {
    await applyHpDelta(prev.target, +prev.appliedHp);
  }
  // Reverse a previous stun if it was a special-fail and now we're changing.
  if (prev?.result === 'fail' && prev?.mode === 'special' && prev?.target) {
    await setPcStunned(prev.target, false);
  }

  // SP accounting: a special attack (first declaration this round) consumes
  // one of the lackey's specials. Re-declaring same target/result within
  // 'special' mode shouldn't double-charge. Switching INTO special mode from
  // basic re-charges; switching OUT (special → basic) refunds.
  const prevConsumedSp = prev?.mode === 'special';
  const nowConsumesSp = mode === 'special';
  if (!prevConsumedSp && nowConsumesSp) {
    await changeLackeySpecial(lackey.id, -1);
  } else if (prevConsumedSp && !nowConsumesSp) {
    await changeLackeySpecial(lackey.id, +1);
  }

  // Apply new damage.
  if (newDmg > 0 && target) {
    await applyHpDelta(target, -newDmg);
  }
  // Apply stun if special-fail.
  if (result === 'fail' && mode === 'special' && target) {
    await setPcStunned(target, true, state.overrides.round);
  }

  const entry = {
    lackeyId: lackey.id,
    lackey: lackey.archetype,
    suit: lackey.suit,
    target,
    cardName: null,
    result,
    mode, // 'special' or 'basic'
    appliedHp: newDmg,
  };
  if (idx >= 0) state.currentRound.lackeyAttacks[idx] = entry;
  else state.currentRound.lackeyAttacks.push(entry);
  saveCurrentRound();
  renderAll();
}

async function setPcStunned(pcName, stunned, round) {
  await mutateTags(
    (it) => {
      const tag = it?.metadata?.[METADATA_NAMESPACE];
      return tag?.role === 'pc' && tag?.name === pcName;
    },
    (tag) => {
      tag.stunned = !!stunned;
      if (stunned && typeof round === 'number') tag.stunnedAt = round;
      else delete tag.stunnedAt;
    },
  );
}

// ----- OBR write helpers (Batch B side-effects) -----

// Specials remaining lives in Stat Bubbles' 'temporary health' field per
// Griz's reuse. NO upper cap — previous Math.min(2, ...) clobbered values
// the GM had set higher than 2 in Stat Bubbles' own UI, surfacing as a
// "-2 per click" instead of -1. 0 is still the floor.
async function changeTempHealth(item, delta, label = '') {
  if (!item) return;
  const apply = (sb) => {
    if (sb && typeof sb['temporary health'] === 'number') {
      const before = sb['temporary health'];
      sb['temporary health'] = Math.max(0, before + delta);
      console.log(`[MP] changeTempHealth ${label}: ${before} → ${sb['temporary health']} (delta=${delta})`);
    }
  };
  if (state.inOwlbear) {
    await OBR.scene.items.updateItems([item.id], (drafts) => {
      for (const draft of drafts) {
        const sb = draft.metadata?.[STAT_BUBBLES_NAMESPACE];
        apply(sb);
        if (sb) draft.metadata[STAT_BUBBLES_NAMESPACE] = sb;
      }
    });
  } else {
    apply(item.metadata?.[STAT_BUBBLES_NAMESPACE]);
  }
}

async function changeSpecial(pcName, delta) {
  const item = state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    return tag?.role === 'pc' && tag?.name === pcName;
  });
  await changeTempHealth(item, delta, `PC ${pcName}`);
}

async function changeLackeySpecial(lackeyId, delta) {
  const item = findLackeyItemByTagId(lackeyId);
  await changeTempHealth(item, delta, `lackey ${lackeyId}`);
}

// HP write to a named target (PC name / "Algorithm" / lackey archetype).
// Writes via Stat Bubbles' `health` field — that's the canonical HP source
// per Wednesday's Batch C decision. Mock-aware so standalone-dev exercises
// the same code.
function findItemByDisplayName(name) {
  if (!name) return null;
  return state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    if (!tag) return false;
    if (tag.role === 'pc' && tag.name === name) return true;
    if (tag.role === 'boss' && (name === 'Algorithm' || name === 'boss')) return true;
    if (tag.role === 'lackey' && tag.archetype === name) return true;
    return false;
  });
}

async function applyHpDelta(targetName, hpDelta) {
  if (!hpDelta) return;
  const item = findItemByDisplayName(targetName);
  if (!item) {
    log(`[hp] no item found for target "${targetName}"`);
    return;
  }
  const writeDraft = (draft) => {
    const sb = draft.metadata?.[STAT_BUBBLES_NAMESPACE];
    const tag = draft.metadata?.[METADATA_NAMESPACE];
    if (sb && typeof sb.health === 'number') {
      const maxH = typeof sb['max health'] === 'number' ? sb['max health'] : sb.health;
      sb.health = Math.max(0, Math.min(maxH, sb.health + hpDelta));
      draft.metadata[STAT_BUBBLES_NAMESPACE] = sb;
    } else if (tag && typeof tag.hp === 'number') {
      tag.hp = Math.max(0, tag.hp + hpDelta);
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  };
  if (state.inOwlbear) {
    await OBR.scene.items.updateItems([item.id], (drafts) => {
      for (const draft of drafts) writeDraft(draft);
    });
  } else {
    writeDraft(item);
  }
}

function computeFormulaAmount(formula, successes) {
  if (!formula) return 0;
  if (successes < 1) return 0;
  return (formula.base || 0) + (formula.mul || 0) * successes;
}

// Apply a damage / heal delta from an action to its target(s). For
// partyWide formulas (Group Heal), each alive PC gets the per-PC amount.
// `deltaAmount` is the *change* to apply — for a counter that ticks from
// 3 to 4 with a 10-per-success formula, the caller passes 10.
async function applyFormulaDelta(targetName, formula, deltaAmount) {
  if (!formula || !deltaAmount) return;
  const sign = formula.kind === 'heal' ? +1 : -1;
  // formula.forceTarget: redirect HP delta away from the action's nominal
  // target (e.g. Denny's Taunt picks an enemy to *taunt* but damages the
  // Algorithm regardless of who's picked).
  const effectiveTarget = formula.forceTarget || targetName;
  if (formula.partyWide) {
    const bs = currentBattleState();
    const alive = (bs.party || []).filter((pc) => pc.hp > 0).map((pc) => pc.name);
    for (const name of alive) {
      await applyHpDelta(name, sign * deltaAmount);
    }
    return;
  }
  await applyHpDelta(effectiveTarget, sign * deltaAmount);
}

// Helper: walk matching items and mutate their tag — mock-aware so the
// standalone preview reflects the same state changes that OBR mode writes.
async function mutateTags(matcher, mutate) {
  const items = state.items.filter(matcher);
  if (!items.length) return;
  if (state.inOwlbear) {
    const ids = items.map((it) => it.id);
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) {
        const tag = draft.metadata?.[METADATA_NAMESPACE];
        if (!tag) continue;
        mutate(tag);
        draft.metadata[METADATA_NAMESPACE] = tag;
      }
    });
  } else {
    for (const it of items) {
      const tag = it.metadata?.[METADATA_NAMESPACE];
      if (!tag) continue;
      mutate(tag);
    }
  }
}

async function setBossTauntedTo(value) {
  await mutateTags(
    (it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss',
    (tag) => { tag.tauntedTo = value; },
  );
}

// Set tauntedTo on a specific enemy by display-name (handles both 'Algorithm'
// and lackey archetypes). Used by Denny's Taunt to extend across multiple
// enemies — primary on cast, +1 enemy per real die-success.
async function setEnemyTauntedTo(enemyName, value) {
  await mutateTags(
    (it) => {
      const t = it?.metadata?.[METADATA_NAMESPACE];
      if (t?.role === 'boss' && enemyName === 'Algorithm') return true;
      if (t?.role === 'lackey' && t?.archetype === enemyName) return true;
      return false;
    },
    (tag) => { tag.tauntedTo = value; },
  );
}

// Clear tauntedTo on every alive enemy (boss + lackeys). Used at end-of-round
// cleanup so the per-cast taunt doesn't persist past the round it applies to.
async function clearAllEnemyTaunts() {
  await mutateTags(
    (it) => {
      const t = it?.metadata?.[METADATA_NAMESPACE];
      return t?.role === 'boss' || t?.role === 'lackey';
    },
    (tag) => { tag.tauntedTo = false; },
  );
}

async function setBossRascalExtraCards(count) {
  await mutateTags(
    (it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss',
    (tag) => { tag.rascalExtraCards = count; },
  );
}

// Boss AC reduction from Baleful Gaze. Cumulative across rounds per Griz's
// 5/21 spec — past gaze contributions stay locked (they're in history); each
// new gaze success in the current round adds to the total. Serializer reads
// this and derives ac = 14 - acReduction.
async function setBossAcReduction(amount) {
  const value = Math.max(0, Math.floor(amount));
  await mutateTags(
    (it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss',
    (tag) => { tag.acReduction = value; },
  );
}

async function setAllPcsBubbled(value) {
  await mutateTags(
    (it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'pc',
    (tag) => { tag.bubbled = !!value; },
  );
}

async function setCrystalUsed(color, used) {
  await mutateTags(
    (it) => {
      const t = it?.metadata?.[METADATA_NAMESPACE];
      return t?.role === 'crystal' && t?.color === color;
    },
    (tag) => { tag.used = !!used; },
  );
}

async function ageStunsAtRoundEnd(currentRound) {
  // Walk PC items, clear stunned where stunnedAt < currentRound (the stun's
  // hero-phase visibility has already happened — it's spent).
  const apply = (draft) => {
    const tag = draft.metadata?.[METADATA_NAMESPACE];
    if (!tag || tag.role !== 'pc') return;
    if (tag.stunned && typeof tag.stunnedAt === 'number' && tag.stunnedAt < currentRound) {
      tag.stunned = false;
      delete tag.stunnedAt;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  };
  const pcs = state.items.filter((it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'pc');
  if (!pcs.length) return;
  if (state.inOwlbear) {
    const ids = pcs.map((it) => it.id);
    await OBR.scene.items.updateItems(ids, (drafts) => {
      for (const draft of drafts) apply(draft);
    });
  } else {
    for (const it of pcs) apply(it);
  }
}

async function setLackeyAlive(lackeyTagId, alive) {
  await mutateTags(
    (it) => {
      const t = it?.metadata?.[METADATA_NAMESPACE];
      if (t?.role !== 'lackey') return false;
      return (t.id || it.id) === lackeyTagId;
    },
    (tag) => { tag.alive = !!alive; },
  );
}

function escapeAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}

// ----- State rendering -----

function renderState() {
  const bs = currentBattleState();

  const pcList = $('pc-list');
  pcList.innerHTML = '';
  if (!bs.party.length) {
    pcList.innerHTML = '<div class="muted">No PC tokens tagged. Right-click a token in OBR → "Monster Party: Add to extension".</div>';
  } else {
    for (const pc of bs.party) {
      const flags = [];
      if (pc.bubbled) flags.push('BUBBLED');
      if (pc.stunned) flags.push('STUNNED');
      const className = `pc-name${pc.bubbled ? ' bubbled' : ''}${pc.stunned ? ' stunned' : ''}`;
      const row = document.createElement('div');
      row.className = 'pc-row';
      row.title = 'Right-click to remove from extension';
      row.innerHTML = `
        <div class="${className}">${pc.name}</div>
        <div>${pc.hp}/${pc.maxHp}</div>
        <div>AC ${pc.ac}</div>
        <div>${pc.actionDiceAvailable}d</div>
        <div class="muted">${flags.join(', ')}</div>
      `;
      attachRemoveContextMenu(row, () => {
        const item = findItemByPcName(pc.name);
        return { itemId: item?.id, label: pc.name };
      });
      pcList.appendChild(row);
    }
  }

  const bossLine = $('boss-line');
  bossLine.innerHTML = '';
  if (bs.boss) {
    const span = document.createElement('span');
    span.title = 'Right-click to remove from extension';
    const acReduction = bs.boss.acReduction || 0;
    const acText = acReduction > 0 ? `AC ${bs.boss.ac} <span class="muted">(14 − ${acReduction} gaze)</span>` : `AC ${bs.boss.ac}`;
    span.innerHTML = `<strong>Algorithm:</strong> ${bs.boss.hp} HP, ${acText}${bs.boss.tauntedTo ? ` · <span class="error">Taunted → ${bs.boss.tauntedTo}</span>` : ''}<span class="muted"> · exhausted: ${bs.boss.cardsExhausted.length}</span>`;
    attachRemoveContextMenu(span, () => {
      const item = findBossItem();
      return { itemId: item?.id, label: 'Algorithm (boss)' };
    });
    bossLine.appendChild(span);
  } else {
    bossLine.innerHTML = '<span class="muted">No boss token tagged.</span>';
  }

  const lackeyList = $('lackey-list');
  lackeyList.innerHTML = '';
  for (const l of bs.lackeys.filter((x) => x.alive)) {
    const row = document.createElement('div');
    row.className = 'enemy-row muted';
    row.title = 'Right-click to remove from extension';
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = `▸ ${l.archetype} (${l.suit}, ${l.hp} HP)`;
    row.appendChild(label);
    const killBtn = document.createElement('button');
    killBtn.className = 'tiny';
    killBtn.textContent = 'Mark killed';
    killBtn.title = 'Mark this lackey dead (writes alive=false to OBR metadata).';
    killBtn.addEventListener('click', () => {
      if (!confirm(`Mark ${l.archetype} as killed?`)) return;
      setLackeyAlive(l.id, false).catch((err) => log(`mark-killed failed: ${err?.message || err}`));
    });
    row.appendChild(killBtn);
    attachRemoveContextMenu(row, () => {
      const item = findLackeyItemByTagId(l.id);
      return { itemId: item?.id, label: l.archetype };
    });
    lackeyList.appendChild(row);
  }

  $('state-display').textContent = JSON.stringify(bs, null, 2);
}

function attachRemoveContextMenu(el, lookup) {
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const { itemId, label } = lookup();
    if (!itemId) {
      console.warn(`[MP] right-click remove: no OBR item found for "${label}"`);
      return;
    }
    removeTagFromItem(itemId, label);
  });
}

function renderChain() {
  const container = $('chain-display');
  container.innerHTML = '';
  $('strategic-note').textContent = '';
  $('monologue-block').style.display = 'none';

  const chain = state.pendingChain;
  if (!chain) return;

  for (const card of chain.chain) {
    const div = document.createElement('div');
    let cls = 'chain-card';
    if (card.result === 'save') cls += ' resolved-save';
    else if (card.result === 'fail') cls += ' resolved-fail';
    else if (card.skipped) cls += ' skipped';
    div.className = cls;

    const dmgFull = SUIT_BINDING[card.suit]?.fullDmg ?? '?';
    const dmgHalf = SUIT_BINDING[card.suit]?.halfDmg ?? '?';
    const dc = SUIT_BINDING[card.suit]?.baseDC ?? '?';

    div.innerHTML = `
      <div class="chain-meta">#${card.order} · ${card.suit} · ${card.cardName} → ${card.targetHero} · DC ${dc} · ${dmgFull}/${dmgHalf} dmg</div>
      <div class="rage-post"></div>
      <div class="muted" style="margin-top:4px;">${escapeHtml(card.reasoning || '')}</div>
      <div class="resolve-row row"></div>
    `;
    div.querySelector('.rage-post').textContent = card.ragePost || '';

    const resolveRow = div.querySelector('.resolve-row');
    if (card.skipped) {
      resolveRow.innerHTML = '<span class="muted">skipped — chain broke earlier</span>';
    } else if (card.result === 'save') {
      resolveRow.innerHTML = `<span class="muted">SAVED — ${dmgHalf} dmg, chain broke here</span>`;
    } else if (card.result === 'fail') {
      resolveRow.innerHTML = `<span class="muted">FAILED — ${dmgFull} dmg, stunned</span>`;
    } else {
      const savedBtn = document.createElement('button');
      savedBtn.textContent = `Save Made (${dmgHalf} dmg, chain breaks)`;
      savedBtn.className = 'saved';
      savedBtn.onclick = () => resolveChainCard(card.order, 'save');
      const failedBtn = document.createElement('button');
      failedBtn.textContent = `Save Failed (${dmgFull} dmg + stun)`;
      failedBtn.className = 'failed';
      failedBtn.onclick = () => resolveChainCard(card.order, 'fail');
      resolveRow.appendChild(savedBtn);
      resolveRow.appendChild(failedBtn);
    }
    container.appendChild(div);
  }

  $('strategic-note').textContent = chain.strategicNote ? `Strategic note: ${chain.strategicNote}` : '';

  if (chain.chainCompleted) {
    $('monologue-block').style.display = 'block';
    $('monologue-text').textContent = chain.monologueIfChainCompletes || '';
  }
}

// ----- Interrupt mechanic (Rascal Fireball at Algo → algo reaction card) -----
//
// Auto-fires when a Fireball action lands on Algorithm (primary OR AoE). Suit
// auto-picks: EXTRACTION (Beholda's suit) unless boss.tauntedTo === 'Denny',
// in which case ASPIRATION. UI has three states:
//   1. Picker      — list unexhausted cards from the suit as name buttons.
//   2. Flipped     — show the full picked card; GM acts it out for the table.
//   3. Resolution  — per-PC Save/Fail buttons. Each PC saves vs their OWN
//                    suit's DC; damage = PC's own-suit full/half. Stun on fail
//                    stamped with stunnedAt = currentRound - 1 so it ages out
//                    at end of THIS hero phase (mid-phase stun blocks remaining
//                    round-N actions; doesn't carry into round N+1).
// Interrupt cards do NOT exhaust on use (the algorithm pulls reactionary
// content; chain pool is preserved for future rounds).

function ensureInterruptForThisRound() {
  // Guard: only one interrupt per round. If already present, no-op.
  if (state.pendingInterrupt) return;
  const bs = currentBattleState();
  const suit = bs.boss?.tauntedTo === 'Denny' ? 'ASPIRATION' : 'EXTRACTION';
  // If voice-Claude pre-declared an interrupt card in pendingChain (parsed
  // from the voice summary block), pre-fill so the GM lands straight on the
  // flipped card view. Otherwise show the picker.
  const preDeclared = state.pendingChain?.interrupt;
  const preCard = preDeclared?.suit === suit ? preDeclared.cardName : null;
  state.pendingInterrupt = {
    suit,
    cardName: preCard || null,
    flipped: !!preCard, // flip open if we have a pre-pick to show
    saves: { Denny: null, Beholda: null, Rascal: null, Goose: null },
    triggeredAtRound: bs.round,
  };
  savePendingInterrupt();
}

function pickInterruptCard(cardName) {
  if (!state.pendingInterrupt) return;
  state.pendingInterrupt.cardName = cardName;
  state.pendingInterrupt.flipped = true; // open straight to the full card so GM can act it out
  savePendingInterrupt();
  renderAll();
}

function flipInterruptCard() {
  if (!state.pendingInterrupt) return;
  state.pendingInterrupt.flipped = !state.pendingInterrupt.flipped;
  savePendingInterrupt();
  renderAll();
}

function cancelInterrupt() {
  if (!state.pendingInterrupt) return;
  // Reverse any applied damage / stun before clearing.
  const interrupt = state.pendingInterrupt;
  for (const pc of PC_ROSTER) {
    if (interrupt.saves[pc]) {
      // No-op — reversals happen per-click on each PC if GM wants to undo.
      // For a full cancel we just clear; manual undo via re-click is the
      // intended path. (Cancel is for "I didn't mean to fire this.")
    }
  }
  state.pendingInterrupt = null;
  savePendingInterrupt();
  renderAll();
}

async function resolveInterruptSave(pcName, result) {
  const interrupt = state.pendingInterrupt;
  if (!interrupt || !interrupt.cardName) return;
  const prev = interrupt.saves[pcName];
  if (prev === result) return; // no change
  // Each PC saves vs their OWN suit's full/half dmg. The interrupt card's
  // suit only sets the SUIT (which decides which deck the GM picks from);
  // damage scales to the saver, not the card.
  const pcSuitByName = {
    Denny: 'ASPIRATION', Beholda: 'EXTRACTION', Rascal: 'CONTROL', Goose: 'EMOTION',
  };
  const pcBinding = SUIT_BINDING[pcSuitByName[pcName]];
  if (!pcBinding) return;
  // Reverse the previous result's damage + stun (idempotent re-clicks).
  if (prev === 'fail') {
    await applyHpDelta(pcName, +pcBinding.fullDmg).catch(() => {});
    await setPcStunned(pcName, false).catch(() => {});
  } else if (prev === 'save') {
    await applyHpDelta(pcName, +pcBinding.halfDmg).catch(() => {});
  }
  // Apply the new result.
  if (result === 'fail') {
    await applyHpDelta(pcName, -pcBinding.fullDmg);
    // Interrupt stun stamps stunnedAt = currentRound - 1 so ageStuns at end
    // of THIS hero phase clears it (blocks any remaining round-N action;
    // doesn't carry into round N+1).
    await setPcStunned(pcName, true, state.overrides.round - 1);
  } else if (result === 'save') {
    await applyHpDelta(pcName, -pcBinding.halfDmg);
  }
  interrupt.saves[pcName] = result;
  savePendingInterrupt();
  renderAll();
}

function renderInterrupt() {
  const root = $('interrupt-block');
  if (!root) return;
  root.innerHTML = '';
  const interrupt = state.pendingInterrupt;
  if (!interrupt) return;
  const suit = interrupt.suit;
  const suitBinding = SUIT_BINDING[suit];
  const suitTarget = suitBinding?.hero || '?';
  const exhausted = currentBattleState().boss?.cardsExhausted || [];
  const available = availableCardsForSuit(suit, exhausted);
  const pickedCard = interrupt.cardName ? CARDS.find((c) => c.name === interrupt.cardName) : null;

  const wrap = document.createElement('div');
  wrap.className = 'interrupt-block';
  wrap.style.cssText = 'border: 2px solid #d4283f; border-radius: 6px; padding: 12px; margin-bottom: 12px; background: #1a0d12;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;';
  header.innerHTML = `
    <strong style="color:#ff8866; letter-spacing:0.1em;">⚡ ALGORITHM INTERRUPT</strong>
    <span class="muted" style="font-size:11px;">Suit: ${suit} (natural target ${suitTarget}). Card does NOT exhaust.</span>
  `;
  wrap.appendChild(header);

  if (!pickedCard) {
    // STATE 1 — Picker
    const help = document.createElement('div');
    help.className = 'muted';
    help.style.cssText = 'font-size:11px; margin-bottom:8px;';
    help.textContent = 'Pick the card the algorithm pulls. Click → flips to show the full card so you can act it out.';
    wrap.appendChild(help);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';
    for (const card of available) {
      const btn = document.createElement('button');
      btn.textContent = card.name;
      btn.style.cssText = 'font-size:12px; padding:6px 10px;';
      btn.addEventListener('click', () => pickInterruptCard(card.name));
      grid.appendChild(btn);
    }
    if (!available.length) {
      grid.innerHTML = '<span class="muted">No unexhausted cards in this suit — the algorithm has no fresh content here.</span>';
    }
    wrap.appendChild(grid);
  } else if (interrupt.flipped) {
    // STATE 2 — Flipped card view
    const card = pickedCard;
    const cardEl = document.createElement('div');
    cardEl.style.cssText = `
      background: #15151c;
      border: 2px solid ${suitBinding?.color === 'purple' ? '#8e44ad' : suitBinding?.color === 'gold' ? '#d4af37' : suitBinding?.color === 'red' ? '#d4283f' : '#e67e22'};
      border-radius: 8px;
      padding: 16px;
      margin: 8px 0;
      cursor: pointer;
      max-width: 360px;
    `;
    cardEl.innerHTML = `
      <div style="text-align:center; font-size:11px; color:#8a8a99; letter-spacing:0.15em; text-transform:uppercase; margin-bottom:6px;">${escapeHtml(card.suit)}</div>
      <div style="text-align:center; font-size:28px; font-weight:800; letter-spacing:0.08em; margin-bottom:8px;">${escapeHtml(card.name)}</div>
      <div style="text-align:center; font-size:11px; color:#9999a8; margin-bottom:12px;">${escapeHtml(card.archetype)}</div>
      <div style="font-size:12px; line-height:1.4; color:#c8c8d4;">${escapeHtml(card.mechanic)}</div>
      <div class="muted" style="font-size:10px; margin-top:12px; text-align:center;">click to flip back → resolve saves</div>
    `;
    cardEl.addEventListener('click', flipInterruptCard);
    wrap.appendChild(cardEl);
  } else {
    // STATE 3 — Resolution (per-PC saves)
    const card = pickedCard;
    const summary = document.createElement('div');
    summary.style.cssText = 'margin-bottom:10px;';
    summary.innerHTML = `
      <div style="display:flex; gap:8px; align-items:baseline;">
        <strong style="font-size:14px;">${escapeHtml(card.name)}</strong>
        <span class="muted" style="font-size:11px;">${escapeHtml(card.suit)} · ${escapeHtml(card.archetype)}</span>
        <button id="interrupt-reflip" class="ghost" style="font-size:10px; padding:2px 6px; margin-left:auto;">show card again</button>
      </div>
      <div class="muted" style="font-size:11px; margin-top:4px;">Every PC saves independently vs their own suit DC. No chain break.</div>
    `;
    wrap.appendChild(summary);

    const savesGrid = document.createElement('div');
    savesGrid.style.cssText = 'display:grid; grid-template-columns: 1fr auto auto; gap:6px; align-items:center;';
    const pcSuitByName = {
      Denny: 'ASPIRATION', Beholda: 'EXTRACTION', Rascal: 'CONTROL', Goose: 'EMOTION',
    };
    for (const pcName of PC_ROSTER) {
      const pcBinding = SUIT_BINDING[pcSuitByName[pcName]];
      const result = interrupt.saves[pcName];
      const label = document.createElement('div');
      label.innerHTML = `
        <strong>${escapeHtml(pcName)}</strong>
        <span class="muted" style="font-size:11px; margin-left:6px;">${pcBinding.save} save vs DC ${pcBinding.baseDC} · ${pcBinding.fullDmg}/${pcBinding.halfDmg} dmg</span>
      `;
      const saveBtn = document.createElement('button');
      saveBtn.className = 'saved';
      saveBtn.style.cssText = 'font-size:11px; padding:4px 8px;';
      saveBtn.textContent = result === 'save' ? `✓ Saved (${pcBinding.halfDmg})` : 'Save';
      saveBtn.addEventListener('click', () => resolveInterruptSave(pcName, 'save'));
      const failBtn = document.createElement('button');
      failBtn.className = 'failed';
      failBtn.style.cssText = 'font-size:11px; padding:4px 8px;';
      failBtn.textContent = result === 'fail' ? `✓ Failed (${pcBinding.fullDmg} + stun)` : 'Fail';
      failBtn.addEventListener('click', () => resolveInterruptSave(pcName, 'fail'));
      savesGrid.appendChild(label);
      savesGrid.appendChild(saveBtn);
      savesGrid.appendChild(failBtn);
    }
    wrap.appendChild(savesGrid);

    summary.querySelector('#interrupt-reflip')?.addEventListener('click', flipInterruptCard);
  }

  // Cancel button always available (lets GM bail on a misfire).
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.style.cssText = 'font-size:10px; padding:3px 8px; margin-top:10px;';
  cancel.textContent = 'Cancel interrupt';
  cancel.addEventListener('click', cancelInterrupt);
  wrap.appendChild(cancel);

  root.appendChild(wrap);
}

function renderHistory() {
  const list = $('history-list');
  list.innerHTML = '';
  if (!state.history.length) {
    list.innerHTML = '<div class="muted">No rounds logged yet.</div>';
    return;
  }
  for (const round of state.history.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'history-round';

    const chainSummary = (round.chain || [])
      .map((c) => `${c.order}. ${c.cardName}→${c.targetHero}: ${c.skipped ? 'skipped' : (c.result || '?')}`)
      .join(' · ');
    const monologue = round.monologueSummoned
      ? ` · <span class="muted">monologue summoned${round.monologueSummoned !== '(GM-typed lackey)' ? ` ${escapeHtml(round.monologueSummoned)}` : ''}</span>`
      : '';

    // Hero actions: per-PC bullets with successes + applied amount when known.
    const heroBullets = (round.heroActions || [])
      .filter((a) => !a.action?.endsWith?.('(AoE)') || a.appliedAmount)
      .map((a) => {
        const succ = (a.successes ?? 0) > 0 ? ` ×${a.successes}` : '';
        const applied = a.appliedAmount
          ? ` <span class="muted">(${a.appliedAmount} ${a.formula?.kind || ''})</span>`
          : '';
        const noteMuted = a.note ? ` <span class="muted">(${escapeHtml(a.note)})</span>` : '';
        return `<div class="muted">  ${escapeHtml(a.pc)}: ${escapeHtml(a.action)}${a.target ? ` → ${escapeHtml(a.target)}` : ''}${succ}${applied}${noteMuted}</div>`;
      });

    const crystalBullets = (round.crystalsUsed || [])
      .map((c) => `<div class="muted">  Crystal: ${escapeHtml(c.color)}${c.note ? ` — ${escapeHtml(c.note)}` : ''}</div>`);

    const noteBullets = (round.heroNotes || [])
      .map((n) => `<div class="muted">  [GM] ${escapeHtml(n)}</div>`);

    const lackeyBullets = (round.lackeyAttacks || [])
      .map((la) => {
        const outcome = la.result === 'save' ? 'SAVED (half dmg)' :
                        la.result === 'fail' ? 'FAILED (full dmg + stun)' :
                        la.result === 'basic' ? `Basic ${la.appliedHp || 15}` :
                        la.result || 'declared';
        const dmg = la.appliedHp ? ` <span class="muted">(${la.appliedHp} dmg)</span>` : '';
        return `<div class="muted">  ${escapeHtml(la.lackey)} (${escapeHtml(la.suit || '?')}) → ${escapeHtml(la.target || '?')}: ${outcome}${dmg}</div>`;
      });

    const heroSummaryLine = round.heroSummary
      ? `<div class="muted">  Notes: ${escapeHtml(round.heroSummary)}</div>`
      : '';

    div.innerHTML = `
      <div><strong>Round ${round.round}</strong> ${chainSummary || '(no chain)'}${monologue}</div>
      ${heroBullets.join('')}
      ${crystalBullets.join('')}
      ${noteBullets.join('')}
      ${lackeyBullets.join('')}
      ${heroSummaryLine}
    `;
    list.appendChild(div);
  }
}

function renderRoundFinalizeVisibility() {
  const chain = state.pendingChain;
  const chainHasResolution = chain && chain.chain?.some((c) => c.result || c.skipped);
  $('round-finalize').style.display = chainHasResolution ? 'block' : 'none';
}

function renderErrorBanner(msg) {
  const banner = document.createElement('div');
  banner.className = 'error';
  banner.textContent = msg;
  banner.style.padding = '12px';
  document.body.prepend(banner);
}

// ----- Voice-mode copy helpers -----

function copyBattleInfoToClipboard() {
  const bs = currentBattleState();
  const { messages } = buildVillainPrompt(bs, state.history, state.currentRound, { voiceMode: true });
  const text = messages[0]?.content || '';
  copyTextToClipboard(text).then(
    (method) => setChainStatus(`Battle info copied (${method}). Paste into voice-mode Claude.`),
    (err) => setChainStatus(`Copy failed: ${err.message || err}`, true),
  );
}

function copySystemPromptToClipboard() {
  const bs = currentBattleState();
  const { system } = buildVillainPrompt(bs, state.history, state.currentRound, { voiceMode: true });
  copyTextToClipboard(system).then(
    (method) => {
      const el = $('system-prompt-status');
      if (el) {
        el.textContent = `Copied (${method}). Paste once at conversation start.`;
        el.style.color = '';
        setTimeout(() => { if (el.textContent.startsWith('Copied')) el.textContent = ''; }, 4000);
      }
    },
    (err) => {
      const el = $('system-prompt-status');
      if (el) { el.textContent = `Copy failed: ${err.message || err}`; el.style.color = '#ff8866'; }
    },
  );
}

// Parse voice-Claude's structured summary block into pendingChain. Tolerant
// of comma OR semicolon separators between entries, case-insensitive section
// headers, and missing optional sections. Returns null on parse error.
function parseVoiceSummary(text) {
  if (!text || typeof text !== 'string') return null;
  const out = { chain: [], lackeyOrders: [], interrupt: null, strategicNote: '' };
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const chainMatch = line.match(/^CHAIN\s*:\s*(.+)$/i);
    if (chainMatch) {
      const entries = chainMatch[1].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      out.chain = entries.map((entry, i) => {
        const m = entry.match(/^(\w+)\s+(.+?)\s*(?:→|->|-->|=>)\s*(\w+)\s*$/);
        if (!m) return null;
        return {
          order: i + 1,
          suit: m[1].toUpperCase(),
          cardName: m[2].trim(),
          targetHero: m[3].trim(),
          ragePost: '',
          reasoning: '',
        };
      }).filter(Boolean);
      continue;
    }
    const lackeyMatch = line.match(/^LACKEYS?\s*:\s*(.+)$/i);
    if (lackeyMatch) {
      const entries = lackeyMatch[1].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      out.lackeyOrders = entries.map((entry) => {
        const m = entry.match(/^(.+?)\s*(?:→|->|-->|=>)\s*(\w+)\s*$/);
        if (!m) return null;
        return { lackeyId: m[1].trim(), targetHero: m[2].trim(), intent: '' };
      }).filter(Boolean);
      continue;
    }
    const interruptMatch = line.match(/^INTERRUPT\s*:\s*(\w+)\s+(.+)$/i);
    if (interruptMatch) {
      out.interrupt = { suit: interruptMatch[1].toUpperCase(), cardName: interruptMatch[2].trim() };
      continue;
    }
    const noteMatch = line.match(/^NOTE\s*:\s*(.+)$/i);
    if (noteMatch) {
      out.strategicNote = noteMatch[1].trim();
      continue;
    }
  }
  return out;
}

async function logChainFromVoiceSummary() {
  const text = $('voice-summary-input').value;
  const setStatus = (msg, isErr = false) => {
    const el = $('voice-log-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? '#ff8866' : '';
  };
  const parsed = parseVoiceSummary(text);
  if (!parsed || !parsed.chain.length) {
    setStatus('Could not find a CHAIN line. Paste the full summary block (CHAIN, LACKEYS, etc.)', true);
    return;
  }
  if (parsed.chain.length !== 4) {
    setStatus(`Expected 4 chain entries, parsed ${parsed.chain.length}. Check the CHAIN line format.`, true);
    return;
  }
  const bs = currentBattleState();
  state.pendingChain = {
    generatedAt: new Date().toISOString(),
    round: bs.round,
    startHp: snapshotHp(bs),
    chain: parsed.chain.map((c) => ({ ...c, result: null, skipped: false })),
    lackeyOrders: parsed.lackeyOrders || [],
    interrupt: parsed.interrupt || null, // batch 3 (#10) will wire this into the interrupt UI
    monologueIfChainCompletes: '',
    strategicNote: parsed.strategicNote || '',
    chainCompleted: false,
  };
  savePendingChain();
  setStatus(`Logged: ${parsed.chain.length} cards, ${parsed.lackeyOrders.length} lackey orders.`);
  // Clear the textarea so a re-paste later doesn't double-log.
  $('voice-summary-input').value = '';
  renderAll();
}

// ----- Chain flow -----

async function generateChain() {
  const apiKey = ($('api-key').value || localStorage.getItem(STORAGE_KEYS.apiKey) || '').trim();
  if (!apiKey) {
    setChainStatus('No API key. Save one in Settings first.', true);
    return;
  }
  const model = $('model').value || 'claude-opus-4-7';

  // Opus 4.7 with ~10k system + 2400 max_tokens typically takes 30-60s.
  // Update status every second so the user can see we're still working.
  const startedAt = Date.now();
  let statusTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    setChainStatus(`Calling Anthropic… ${elapsed}s elapsed. (Opus typically 30-60s. Don't reload.)`);
  }, 1000);
  setChainStatus('Calling Anthropic… 0s elapsed. (Opus typically 30-60s. Don\'t reload.)');
  $('generate-chain').disabled = true;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); // 3min hard cap

  try {
    const bs = currentBattleState();
    const { system, messages } = buildVillainPrompt(bs, state.history, state.currentRound);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2400,
        system,
        messages,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }
    const data = await res.json();
    const rawText = data?.content?.[0]?.text || '';
    const parsed = parseVillainResponse(rawText);

    state.pendingChain = {
      generatedAt: new Date().toISOString(),
      round: bs.round,
      // Snapshot HP at the moment the villain is about to act, so future rounds
      // can render this in history and the villain can infer per-round damage
      // deltas without needing numeric annotations in hero-action log lines.
      startHp: snapshotHp(bs),
      chain: parsed.chain.map((c) => ({ ...c, result: null, skipped: false })),
      // lackeyOrders: villain's per-lackey targeting decisions for this round.
      // Pre-fills the lackey row dropdowns in renderLackeyAttacksBlock. The GM
      // can still override at click time (e.g. if the order doesn't make sense
      // in play); taunt-redirect (lackey.tauntedTo='Denny') trumps the order.
      lackeyOrders: Array.isArray(parsed.lackeyOrders) ? parsed.lackeyOrders : [],
      monologueIfChainCompletes: parsed.monologueIfChainCompletes || '',
      strategicNote: parsed.strategicNote || '',
      chainCompleted: false,
    };
    savePendingChain();
    setChainStatus(`Got chain (${parsed.chain.length} cards). Resolve in order.`);
    renderChain();
    renderRoundFinalizeVisibility();
  } catch (err) {
    const msg = err?.name === 'AbortError'
      ? 'Aborted after 3 min hard cap. Try again, or check API status.'
      : `Error: ${err.message || err}`;
    setChainStatus(msg, true);
  } finally {
    clearInterval(statusTimer);
    clearTimeout(timeoutId);
    $('generate-chain').disabled = false;
  }
}

function resolveChainCard(order, result) {
  const chain = state.pendingChain;
  if (!chain) return;
  const cards = chain.chain;
  const card = cards.find((c) => c.order === order);
  if (!card) return;
  card.result = result;

  // Chain breaks on a save: mark all later cards as skipped.
  if (result === 'save') {
    for (const later of cards) {
      if (later.order > order && !later.result && !later.skipped) {
        later.skipped = true;
      }
    }
  }

  // If all 4 failed, chain completed → monologue.
  const allFailed = cards.every((c) => c.result === 'fail');
  chain.chainCompleted = allFailed;

  savePendingChain();
  applyDamageToToken(card, result).catch((err) =>
    log(`token HP update failed: ${err?.message || err}`),
  );
  renderChain();
  renderRoundFinalizeVisibility();
}

async function applyDamageToToken(card, result) {
  if (!state.inOwlbear) return;
  const dmg = result === 'save' ? SUIT_BINDING[card.suit]?.halfDmg : SUIT_BINDING[card.suit]?.fullDmg;
  if (typeof dmg !== 'number') return;

  // Find the target PC's item id up-front so we don't iterate the whole scene
  // inside the updateItems callback.
  const target = state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    return tag?.role === 'pc' && tag?.name === card.targetHero;
  });
  if (!target) return;

  await OBR.scene.items.updateItems([target.id], (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'pc' || tag.name !== card.targetHero) continue;

      // Stat Bubbles is the canonical HP source — read/write to its namespace
      // so its floating bubble updates live. Fall back to our tag.hp only if
      // the token has no Stat Bubbles metadata yet (un-bubbled token).
      const sb = draft.metadata[STAT_BUBBLES_NAMESPACE];
      if (sb && typeof sb.health === 'number') {
        sb.health = Math.max(0, sb.health - dmg);
        draft.metadata[STAT_BUBBLES_NAMESPACE] = sb;
      } else {
        tag.hp = Math.max(0, (tag.hp || 0) - dmg);
      }

      if (result === 'fail') {
        tag.stunned = true;
        // Tag the round-of-stun so endRound's age pass knows when to clear it.
        // Stun lasts one round per battle-info §3: applied in round-N villain
        // phase → visible in round N+1 hero phase → cleared at end of N+1.
        tag.stunnedAt = state.pendingChain?.round ?? state.overrides.round;
      }
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

function endRound() {
  const chain = state.pendingChain;
  if (!chain) return;
  const heroSummaryInput = $('hero-summary');
  const heroSummary = heroSummaryInput ? heroSummaryInput.value.trim() : '';

  const round = {
    round: chain.round,
    startHp: chain.startHp || null,
    chain: chain.chain.map((c) => ({
      order: c.order, suit: c.suit, cardName: c.cardName,
      targetHero: c.targetHero, result: c.result, skipped: !!c.skipped,
    })),
    chainBrokenAt: chain.chain.find((c) => c.result === 'save')?.order ?? null,
    monologueSummoned: chain.chainCompleted ? '(GM-typed lackey)' : null,
    heroActions: (state.currentRound.heroPhase.pcActions || []).slice(),
    crystalsUsed: (state.currentRound.heroPhase.crystalsUsed || []).slice(),
    heroNotes: (state.currentRound.heroPhase.notes || []).slice(),
    lackeyAttacks: (state.currentRound.lackeyAttacks || []).slice(),
    heroSummary,
  };

  state.history.push(round);
  saveHistory();

  // Append chain card names to boss.cardsExhausted via OBR if connected.
  appendExhausted(chain.chain.filter((c) => !c.skipped).map((c) => c.cardName)).catch(
    (err) => log(`exhausted update failed: ${err?.message || err}`),
  );

  // End-of-round cleanup: bubbles are one-round, clear them so next round
  // starts unbubbled unless Beholda re-raises. Boss taunt also clears (a
  // round's worth, per battle-info §2). rascalExtraCards is the +N bonus
  // for the round AFTER the cast — once that round ends, reset to 0.
  setAllPcsBubbled(false).catch((err) => log(`bubble clear failed: ${err?.message || err}`));
  clearAllEnemyTaunts().catch((err) => log(`taunt clear failed: ${err?.message || err}`));
  setBossRascalExtraCards(0).catch((err) => log(`rascalExtraCards clear failed: ${err?.message || err}`));

  // Stun aging happens in endHeroTurn, not here — the stun-clear point is
  // "end of party turn" (right before villain phase starts again), not
  // end of round. See endHeroTurn for the comment.

  // Bump round + clear chain + reset currentRound (phase → party for next round).
  state.overrides.round = (state.overrides.round || 1) + 1;
  $('ov-round').value = state.overrides.round;
  saveOverrides();
  state.pendingChain = null;
  savePendingChain();
  // Clear any pending interrupt — interrupts are per-round, so even if the GM
  // forgot to resolve one before End Round, dropping it on the floor here is
  // safer than carrying stale interrupt UI into the next round.
  state.pendingInterrupt = null;
  savePendingInterrupt();
  state.currentRound = emptyCurrentRound();
  saveCurrentRound();
  if (heroSummaryInput) heroSummaryInput.value = '';
  setChainStatus(`Round ${round.round} logged. On to round ${state.overrides.round}.`);
  renderAll();
}

async function appendExhausted(cardNames) {
  if (!state.inOwlbear || !cardNames.length) return;
  await OBR.scene.items.updateItems(state.items.map((i) => i.id), (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'boss') continue;
      tag.cardsExhausted = [...(tag.cardsExhausted || []), ...cardNames];
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

function copyHistoryToClipboard() {
  const text = state.history.map(formatRoundForPaste).join('\n\n');
  copyTextToClipboard(text).then(
    (method) => setChainStatus(`History copied (${method}).`),
    (err) => setChainStatus(`Copy failed: ${err.message || err}`, true),
  );
}

// Plain-text rich format for the clipboard. Mirrors prompt-builder's
// formatHistoryRound shape so a paste-into-voice-instance gives the same
// context the API call would have sent.
function formatRoundForPaste(r) {
  const lines = [`Round ${r.round}`];
  if (r.startHp) {
    const partyEntries = Object.entries(r.startHp.party || {});
    const parts = [];
    if (partyEntries.length) {
      parts.push(partyEntries.map(([n, s]) => `${n} ${s.hp}/${s.maxHp}`).join(', '));
    }
    if (r.startHp.boss && typeof r.startHp.boss.hp === 'number') parts.push(`You: ${r.startHp.boss.hp}`);
    const aliveLackeys = (r.startHp.lackeys || []).filter((l) => l.alive);
    if (aliveLackeys.length) parts.push(`Lackeys: ${aliveLackeys.map((l) => `${l.archetype} ${l.hp}`).join(', ')}`);
    if (parts.length) lines.push(`  HP entering turn — ${parts.join(' · ')}`);
  }
  if (r.chain?.length) {
    lines.push('  Villain chain:');
    for (const c of r.chain) {
      const outcome = c.skipped ? 'skipped' :
                      c.result === 'save' ? 'SAVED (half dmg, chain broke)' :
                      c.result === 'fail' ? 'FAILED (full dmg, stunned)' :
                      c.result || 'unresolved';
      lines.push(`    ${c.order}. ${c.suit ? c.suit + ' ' : ''}${c.cardName} → ${c.targetHero}: ${outcome}`);
    }
    if (r.chainBrokenAt != null) lines.push(`    Chain broke at card ${r.chainBrokenAt}.`);
    if (r.monologueSummoned) lines.push(`    Monologue landed — summoned ${r.monologueSummoned}.`);
  }
  if (r.heroActions?.length) {
    lines.push('  Hero turn:');
    for (const a of r.heroActions) {
      const succ = (a.successes ?? 0) > 0 ? ` ×${a.successes}` : '';
      const applied = a.appliedAmount ? ` (${a.appliedAmount} ${a.formula?.kind || ''})` : '';
      const note = a.note ? ` — ${a.note}` : '';
      lines.push(`    ${a.pc}: ${a.action}${a.target ? ` → ${a.target}` : ''}${succ}${applied}${note}`);
    }
  }
  if (r.crystalsUsed?.length) {
    for (const c of r.crystalsUsed) {
      const note = c.note ? ` — ${c.note}` : '';
      lines.push(`    Party used the ${c.color} crystal${note}`);
    }
  }
  if (r.heroNotes?.length) {
    for (const n of r.heroNotes) lines.push(`    [GM] ${n}`);
  }
  if (r.lackeyAttacks?.length) {
    lines.push('  Your lackeys:');
    for (const la of r.lackeyAttacks) {
      const outcome = la.result === 'save' ? 'SAVED (half dmg)' :
                      la.result === 'fail' ? 'FAILED (full dmg + stun)' :
                      la.result === 'basic' ? `Basic ${la.appliedHp || 15} dmg` :
                      la.result || 'declared';
      const dmg = la.appliedHp ? ` (${la.appliedHp} dmg)` : '';
      lines.push(`    ${la.lackey} (${la.suit}) → ${la.target}: ${outcome}${dmg}`);
    }
  }
  if (r.heroSummary) lines.push(`  Notes: ${r.heroSummary}`);
  return lines.join('\n');
}

// Clipboard write with fallback. OBR's iframe sandbox doesn't grant the
// clipboard-write permission, so navigator.clipboard.writeText throws a
// Permissions Policy violation. Falls back to a temporary textarea +
// document.execCommand('copy'), which works under a user-initiated click
// without the permission.
async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'clipboard API';
    } catch (_) {
      // fall through to execCommand path
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand returned false');
    return 'execCommand fallback';
  } finally {
    document.body.removeChild(ta);
  }
}

function setChainStatus(text, isError = false) {
  const el = $('chain-status');
  el.textContent = text;
  el.className = isError ? 'error' : 'muted';
}

// ----- Persistence helpers -----

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.overrides);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { round: 1, bonusDieWinner: null, rescuedMemberEmojiCount: 0 };
}
function saveOverrides() {
  localStorage.setItem(STORAGE_KEYS.overrides, JSON.stringify(state.overrides));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.history);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}
function saveHistory() {
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
}

function loadPendingInterrupt() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.pendingInterrupt);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function savePendingInterrupt() {
  if (state.pendingInterrupt) {
    localStorage.setItem(STORAGE_KEYS.pendingInterrupt, JSON.stringify(state.pendingInterrupt));
  } else {
    localStorage.removeItem(STORAGE_KEYS.pendingInterrupt);
  }
}

function loadPendingChain() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.pendingChain);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}
function savePendingChain() {
  if (state.pendingChain) {
    localStorage.setItem(STORAGE_KEYS.pendingChain, JSON.stringify(state.pendingChain));
  } else {
    localStorage.removeItem(STORAGE_KEYS.pendingChain);
  }
}

function loadCurrentRound() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.currentRound);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Defensive: ensure shape is intact if storage was written by an older build.
      return {
        phase: parsed.phase === 'villain' ? 'villain' : 'party',
        heroPhase: {
          pcActions: parsed.heroPhase?.pcActions || [],
          crystalsUsed: parsed.heroPhase?.crystalsUsed || [],
          notes: parsed.heroPhase?.notes || [],
        },
        lackeyAttacks: parsed.lackeyAttacks || [],
      };
    }
  } catch (_) {}
  return emptyCurrentRound();
}
function saveCurrentRound() {
  localStorage.setItem(STORAGE_KEYS.currentRound, JSON.stringify(state.currentRound));
}

// ----- Utils -----

function snapshotHp(bs) {
  return {
    party: Object.fromEntries((bs.party || []).map((pc) => [pc.name, { hp: pc.hp, maxHp: pc.maxHp }])),
    boss: bs.boss ? { hp: bs.boss.hp } : null,
    lackeys: (bs.lackeys || []).map((l) => ({ id: l.id, archetype: l.archetype, suit: l.suit, hp: l.hp, alive: l.alive })),
  };
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function log(line) {
  console.log('[mp-villain]', line);
}

// ----- Mock scene for standalone dev -----

function mockSceneItems() {
  // Mocks include Stat Bubbles metadata (health, max health, temporary health
  // = specials remaining per Griz's reuse) so the standalone-dev render path
  // exercises the same code as inside OBR.
  const sb = (hp, specials = 2) => ({
    health: hp, 'max health': hp, 'temporary health': specials,
    'armor class': 4, hide: false,
  });
  return [
    { id: 'mock-denny',   type: 'IMAGE', name: 'Denny',
      metadata: { [METADATA_NAMESPACE]: defaultPcTag('Denny'),
                  [STAT_BUBBLES_NAMESPACE]: sb(150) } },
    { id: 'mock-beholda', type: 'IMAGE', name: 'Beholda',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Beholda'), bubbled: true },
                  [STAT_BUBBLES_NAMESPACE]: sb(112) } },
    { id: 'mock-rascal',  type: 'IMAGE', name: 'Rascal',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Rascal'),  bubbled: true },
                  [STAT_BUBBLES_NAMESPACE]: sb(88) } },
    { id: 'mock-goose',   type: 'IMAGE', name: 'Goose',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Goose'),   bubbled: true },
                  [STAT_BUBBLES_NAMESPACE]: sb(81) } },
    { id: 'mock-boss',    type: 'IMAGE', name: 'Algorithm',
      metadata: { [METADATA_NAMESPACE]: { role: 'boss', cardsExhausted: [], tauntedTo: false },
                  [STAT_BUBBLES_NAMESPACE]: sb(500, 0) } },
    { id: 'mock-lackey-emotion', type: 'IMAGE', name: 'Alex-Jones-Bot',
      metadata: { [METADATA_NAMESPACE]: { role: 'lackey', suit: 'EMOTION', archetype: 'Alex-Jones-Bot', alive: true, cardsExhausted: [] },
                  [STAT_BUBBLES_NAMESPACE]: sb(50, 0) } },
    { id: 'mock-lackey-control', type: 'IMAGE', name: 'Hasan-Piker-Bot',
      metadata: { [METADATA_NAMESPACE]: { role: 'lackey', suit: 'CONTROL', archetype: 'Hasan-Piker-Bot', alive: true, cardsExhausted: [] },
                  [STAT_BUBBLES_NAMESPACE]: sb(50, 0) } },
    { id: 'mock-crystal-green',  type: 'IMAGE', name: 'Green Crystal',
      metadata: { [METADATA_NAMESPACE]: { role: 'crystal', color: 'Green', used: false } } },
    { id: 'mock-crystal-yellow', type: 'IMAGE', name: 'Yellow Crystal',
      metadata: { [METADATA_NAMESPACE]: { role: 'crystal', color: 'Yellow', used: false } } },
  ];
}
