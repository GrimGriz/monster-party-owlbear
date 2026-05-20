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
import { SUIT_BINDING } from '../state-pipe/cards-by-target.js';
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
};

// Locked boss-fight specials per PC (mechanics-audit-2026-05-18 §2 / battle-info §2).
// `target` controls how the action picks a target:
//   'pick'    — uses the PC card's target dropdown selection
//   'pick-pc' — uses the dropdown but expects a PC name (heals / share)
//   'party'   — fixed to "Party", dropdown ignored
//   'boss'    — fixed to "Algorithm" (boss), dropdown ignored
//   'self'    — fixed to the PC themselves
// `sideEffect` is dispatched in dispatchSideEffect() — taunt, bubble, fireball-trigger, etc.
const PC_ACTIONS = {
  Denny: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick' },
    { id: 'taunt',  label: 'Taunt',         isSpecial: true,  target: 'boss', sideEffect: 'taunt' },
    { id: 'denim',  label: 'Denim Damage',  isSpecial: true,  target: 'pick' },
  ],
  Beholda: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick' },
    { id: 'vna',    label: 'VNA Bubble',    isSpecial: true,  target: 'party', sideEffect: 'bubble' },
    { id: 'gaze',   label: 'Baleful Gaze',  isSpecial: true,  target: 'boss' },
  ],
  Rascal: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick' },
    { id: 'fire',   label: 'Range Fireball', isSpecial: true, target: 'pick', sideEffect: 'fireball' },
    { id: 'share',  label: 'Dice-Share',    isSpecial: true,  target: 'pick-pc' },
  ],
  Goose: [
    { id: 'basic',  label: 'Basic atk',     isSpecial: false, target: 'pick' },
    { id: 'group',  label: 'Group Heal',    isSpecial: true,  target: 'party' },
    { id: 'single', label: 'Single Heal',   isSpecial: true,  target: 'pick-pc' },
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
  currentRound: loadCurrentRound(),
};

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
const BUILD_TAG = '2026-05-21-batch-b-hero-phase';

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

  // Lackeys — known archetypes first, then bare suit names.
  if (haystack.includes('alex') && haystack.includes('jones')) {
    return { role: 'lackey', suit: 'EMOTION', archetype: 'Alex-Jones-Bot', alive: true, cardsExhausted: [] };
  }
  if (haystack.includes('hasan') && haystack.includes('piker')) {
    return { role: 'lackey', suit: 'CONTROL', archetype: 'Hasan-Piker-Bot', alive: true, cardsExhausted: [] };
  }
  if (haystack.includes('aspiration')) {
    return { role: 'lackey', suit: 'ASPIRATION', archetype: 'ASPIRATION lackey', alive: true, cardsExhausted: [] };
  }
  if (haystack.includes('extraction')) {
    return { role: 'lackey', suit: 'EXTRACTION', archetype: 'EXTRACTION lackey', alive: true, cardsExhausted: [] };
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

async function handleAddClick(items) {
  if (!items.length) {
    console.log('[MP] mp-add click → no items selected');
    return;
  }
  for (const item of items) {
    const assetName = item?.name || '';
    const textName = item?.text?.plainText || '';
    const tag = autoDetectRoleFromItem(item);
    if (!tag) {
      console.warn(
        `[MP] mp-add: no role match for asset="${assetName}" text="${textName}" (id=${item.id}). ` +
        `Edit the token text (right-click → Edit Text) to include one of: ` +
        `Denny, Beholda, Rascal, Goose, Algorithm, Alex-Jones, Hasan-Piker, ` +
        `ASPIRATION, EXTRACTION — then retry. (Asset name also works.)`,
      );
      continue;
    }
    console.log(`[MP] mp-add: asset="${assetName}" text="${textName}" → ${tag.role}:${tag.name || tag.archetype || 'boss'}`);
    await writeTagToSelection([item], tag);
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

async function writeTagToSelection(items, tag) {
  if (!items?.length) return;
  const ids = items.map((it) => it.id);
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      if (tag === null) {
        delete draft.metadata[METADATA_NAMESPACE];
      } else {
        draft.metadata[METADATA_NAMESPACE] = tag;
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
  $('save-settings').addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEYS.apiKey, $('api-key').value.trim());
    localStorage.setItem(STORAGE_KEYS.model, $('model').value);
    $('settings-status').textContent = 'saved.';
    setTimeout(() => { $('settings-status').textContent = ''; }, 2000);
  });

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

  $('generate-chain').addEventListener('click', generateChain);
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
  const k = localStorage.getItem(STORAGE_KEYS.apiKey);
  if (k) $('api-key').value = k;
  const m = localStorage.getItem(STORAGE_KEYS.model);
  if (m) $('model').value = m;
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

  for (const pcName of PC_ROSTER) {
    const pc = partyByName[pcName];
    if (!pc) continue; // not tagged; skip
    const card = document.createElement('div');
    const dead = pc.hp <= 0;
    const stunned = !!pc.stunned;
    const classes = ['hero-pc', pcName.toLowerCase()];
    if (dead) classes.push('dead');
    else if (stunned) classes.push('stunned');
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
      const disabled = dead || stunned || heroPhaseEnded || (isSp && specials < 1);
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
  const entries = [];
  actions.forEach((a, idx) => entries.push({ kind: 'action', idx, html:
    `<span class="who">${escapeHtml(a.pc)}</span><span class="what">${escapeHtml(a.action)}${a.target ? ` → ${escapeHtml(a.target)}` : ''}${a.note ? ` (${escapeHtml(a.note)})` : ''}</span>` }));
  crystals.forEach((c, idx) => entries.push({ kind: 'crystal', idx, html:
    `<span class="who">Crystal</span><span class="what">${escapeHtml(c.color)} used${c.note ? ` — ${escapeHtml(c.note)}` : ''}</span>` }));
  notes.forEach((n, idx) => entries.push({ kind: 'note', idx, html:
    `<span class="who">GM</span><span class="what">${escapeHtml(n)}</span>` }));

  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `${e.html}<button class="x" title="Remove entry">×</button>`;
    row.querySelector('button.x').addEventListener('click', () => {
      removeHeroPhaseEntry(e.kind, e.idx);
    });
    root.appendChild(row);
  }
}

function removeHeroPhaseEntry(kind, idx) {
  const hp = state.currentRound.heroPhase;
  if (kind === 'action') hp.pcActions.splice(idx, 1);
  else if (kind === 'crystal') hp.crystalsUsed.splice(idx, 1);
  else if (kind === 'note') hp.notes.splice(idx, 1);
  saveCurrentRound();
  renderHeroPhase();
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

  // Log the action.
  state.currentRound.heroPhase.pcActions.push({
    pc: pcName, action: action.label, target,
    note: sideEffectResult?.note || '',
  });
  saveCurrentRound();

  // Decrement Stat Bubbles temporary health for SPs (specials remaining).
  if (action.isSpecial) {
    try { await decrementSpecial(pcName); } catch (err) {
      console.error('[MP] decrementSpecial:', stringifyErr(err));
    }
  }

  // If the side effect forces a phase flip, do it last so the log entry above
  // is already committed.
  if (sideEffectResult?.flipToVillain) {
    state.currentRound.phase = 'villain';
    saveCurrentRound();
  }

  renderAll();
}

async function dispatchSideEffect(pcName, action, target) {
  switch (action.sideEffect) {
    case 'taunt': {
      // Denny Taunt — set boss.tauntedTo='Denny' so next villain card targets her.
      await setBossTauntedTo('Denny').catch((err) =>
        log(`taunt write failed: ${err?.message || err}`),
      );
      return { note: 'next villain card MUST target Denny' };
    }
    case 'bubble': {
      // Beholda VNA Bubble — all PCs bubbled for one round (AC 14 → 19).
      await setAllPcsBubbled(true).catch((err) =>
        log(`bubble write failed: ${err?.message || err}`),
      );
      return { note: 'party AC 19 this round' };
    }
    case 'fireball': {
      // Range Fireball vs the Algorithm triggers: log [TRIGGER], record success
      // count for villain's next-round extra-card calc, force phase to villain
      // (other PCs' remaining actions are skipped — Rascal's special cut the turn).
      if (target !== 'Algorithm') return null;
      const raw = prompt(
        'Range Fireball at the Algorithm — how many die-successes vs Algo?\n' +
        '(Each success fuels +1 extra villain card next round.)',
        '0',
      );
      if (raw == null) return { abort: true }; // cancelled
      const successes = Math.max(0, parseInt(raw, 10) || 0);
      state.currentRound.heroPhase.notes.push(
        `[TRIGGER] Rascal fireballed the Algorithm: ${successes} die-successes — ` +
        `Algorithm plays +${successes} extra cards next round. Hero phase cut short here.`,
      );
      await setBossRascalExtraCards(successes).catch((err) =>
        log(`rascalExtraCards write failed: ${err?.message || err}`),
      );
      return { note: `${successes} successes → +${successes} villain cards next round`, flipToVillain: true };
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

async function endHeroTurn() {
  state.currentRound.phase = 'villain';
  saveCurrentRound();
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
    const targetOptions = PC_ROSTER
      .map((n) => `<option value="${escapeAttr(n)}" ${(existing?.target || suitHero) === n ? 'selected' : ''}>${escapeHtml(n)}</option>`)
      .join('');

    const row = document.createElement('div');
    row.className = 'lackey-attack-row' + (existing?.result ? ' resolved' : '');
    row.innerHTML = `
      <div><strong>${escapeHtml(l.archetype)}</strong> <span class="muted">(${escapeHtml(l.suit || '?')}, ${l.hp} HP)</span></div>
      <select data-target>${targetOptions}</select>
      <button class="saved" data-result="save">${existing?.result === 'save' ? '✓ Saved' : 'Save'}</button>
      <button class="failed" data-result="fail">${existing?.result === 'fail' ? '✓ Failed' : 'Fail'}</button>
    `;
    row.querySelector('select[data-target]').addEventListener('change', (e) => {
      upsertLackeyAttack(l, e.target.value, existing?.result || null);
    });
    row.querySelectorAll('button[data-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tgt = row.querySelector('select[data-target]').value;
        upsertLackeyAttack(l, tgt, btn.getAttribute('data-result'));
      });
    });
    wrap.appendChild(row);
  }
  root.appendChild(wrap);
}

function upsertLackeyAttack(lackey, target, result) {
  const idx = state.currentRound.lackeyAttacks.findIndex((la) => la.lackeyId === lackey.id);
  const entry = {
    lackeyId: lackey.id,
    lackey: lackey.archetype,
    suit: lackey.suit,
    target,
    cardName: null,
    result,
  };
  if (idx >= 0) state.currentRound.lackeyAttacks[idx] = entry;
  else state.currentRound.lackeyAttacks.push(entry);
  saveCurrentRound();
  renderAll();
}

// ----- OBR write helpers (Batch B side-effects) -----

async function decrementSpecial(pcName) {
  if (!state.inOwlbear) return;
  const item = state.items.find((it) => {
    const tag = it?.metadata?.[METADATA_NAMESPACE];
    return tag?.role === 'pc' && tag?.name === pcName;
  });
  if (!item) return;
  await OBR.scene.items.updateItems([item.id], (drafts) => {
    for (const draft of drafts) {
      const sb = draft.metadata?.[STAT_BUBBLES_NAMESPACE];
      if (sb && typeof sb['temporary health'] === 'number') {
        sb['temporary health'] = Math.max(0, sb['temporary health'] - 1);
        draft.metadata[STAT_BUBBLES_NAMESPACE] = sb;
      }
    }
  });
}

async function setBossTauntedTo(value) {
  if (!state.inOwlbear) return;
  const item = state.items.find((it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss');
  if (!item) return;
  await OBR.scene.items.updateItems([item.id], (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'boss') continue;
      tag.tauntedTo = value;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

async function setBossRascalExtraCards(count) {
  if (!state.inOwlbear) return;
  const item = state.items.find((it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'boss');
  if (!item) return;
  await OBR.scene.items.updateItems([item.id], (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'boss') continue;
      tag.rascalExtraCards = count;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

async function setAllPcsBubbled(value) {
  if (!state.inOwlbear) return;
  const pcItems = state.items.filter((it) => it?.metadata?.[METADATA_NAMESPACE]?.role === 'pc');
  const ids = pcItems.map((it) => it.id);
  if (!ids.length) return;
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'pc') continue;
      tag.bubbled = !!value;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

async function setCrystalUsed(color, used) {
  if (!state.inOwlbear) return;
  const item = state.items.find((it) => {
    const t = it?.metadata?.[METADATA_NAMESPACE];
    return t?.role === 'crystal' && t?.color === color;
  });
  if (!item) return;
  await OBR.scene.items.updateItems([item.id], (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'crystal') continue;
      tag.used = !!used;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

async function setLackeyAlive(lackeyTagId, alive) {
  if (!state.inOwlbear) return;
  const item = findLackeyItemByTagId(lackeyTagId);
  if (!item) return;
  await OBR.scene.items.updateItems([item.id], (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'lackey') continue;
      tag.alive = !!alive;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
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
    span.innerHTML = `<strong>Algorithm:</strong> ${bs.boss.hp} HP, AC ${bs.boss.ac}${bs.boss.tauntedTo ? ` · <span class="error">Taunted → ${bs.boss.tauntedTo}</span>` : ''}<span class="muted"> · exhausted: ${bs.boss.cardsExhausted.length}</span>`;
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
      ? ` · monologue summoned ${round.monologueSummoned}`
      : '';
    const heroLine = round.heroSummary
      ? `<div class="muted">Heroes: ${escapeHtml(round.heroSummary)}</div>`
      : '';
    div.innerHTML = `
      <div><strong>Round ${round.round}</strong> ${chainSummary || '(no chain)'}${monologue}</div>
      ${heroLine}
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

      if (result === 'fail') tag.stunned = true;
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
  // round's worth, per battle-info §2).
  setAllPcsBubbled(false).catch((err) => log(`bubble clear failed: ${err?.message || err}`));
  setBossTauntedTo(false).catch((err) => log(`taunt clear failed: ${err?.message || err}`));

  // Bump round + clear chain + reset currentRound (phase → party for next round).
  state.overrides.round = (state.overrides.round || 1) + 1;
  $('ov-round').value = state.overrides.round;
  saveOverrides();
  state.pendingChain = null;
  savePendingChain();
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
  const text = state.history.map((r) =>
    `Round ${r.round}\n` +
    (r.chain || []).map((c) => `  ${c.order}. ${c.suit} ${c.cardName}→${c.targetHero}: ${c.skipped ? 'skipped' : c.result}`).join('\n') +
    (r.heroSummary ? `\nHeroes: ${r.heroSummary}` : '')
  ).join('\n\n');
  copyTextToClipboard(text).then(
    (method) => setChainStatus(`History copied (${method}).`),
    (err) => setChainStatus(`Copy failed: ${err.message || err}`, true),
  );
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
