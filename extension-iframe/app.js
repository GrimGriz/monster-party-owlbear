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
} from '../state-pipe/serializer.js';
import { SUIT_BINDING } from '../state-pipe/cards-by-target.js';
import {
  buildVillainPrompt,
  parseVillainResponse,
} from '../state-pipe/prompt-builder.js';

const $ = (id) => document.getElementById(id);

const PC_ROSTER = ['Denny', 'Beholda', 'Rascal', 'Goose'];
const STORAGE_KEYS = {
  apiKey: 'mp-villain.apiKey',
  model: 'mp-villain.model',
  overrides: 'mp-villain.gmOverrides',
  history: 'mp-villain.history',
  pendingChain: 'mp-villain.pendingChain',
};

const state = {
  inOwlbear: false,
  items: [],
  overrides: loadOverrides(),
  history: loadHistory(),
  pendingChain: loadPendingChain(),
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

main();

async function main() {
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

  try {
    console.log('[MP] step: registerTokenTaggingMenu');
    await registerTokenTaggingMenu();
  } catch (err) {
    console.error('[MP] registerTokenTaggingMenu failed:', stringifyErr(err));
  }

  try {
    console.log('[MP] step: getItems');
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
}

function dumpItemMetadata(it) {
  const ns = it?.metadata ? Object.keys(it.metadata) : [];
  console.log(`[MP] tagged-meta ${it.name || it.id} namespaces: [${ns.join(', ')}]`);
  for (const key of ns) {
    console.log(`  ${key} =`, JSON.stringify(it.metadata[key]));
  }

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

  window.addEventListener('beforeunload', () => {
    if (unsubscribeItems) unsubscribeItems();
  });
}

// ----- Token tagging context menu -----

async function registerTokenTaggingMenu() {
  const entries = [
    ...PC_ROSTER.map((name) => ({
      id: `mp-tag-pc-${name.toLowerCase()}`,
      label: `Monster Party: Tag as ${name}`,
      tag: defaultPcTag(name),
    })),
    {
      id: 'mp-tag-boss',
      label: 'Monster Party: Tag as Boss (Algorithm)',
      tag: { role: 'boss', hp: 500, ac: 14, cardsExhausted: [], tauntedTo: false },
    },
    {
      id: 'mp-tag-lackey-aspiration',
      label: 'Monster Party: Tag lackey (ASPIRATION)',
      tag: { role: 'lackey', suit: 'ASPIRATION', archetype: 'ASPIRATION lackey', hp: 50, alive: true, cardsExhausted: [] },
    },
    {
      id: 'mp-tag-lackey-extraction',
      label: 'Monster Party: Tag lackey (EXTRACTION)',
      tag: { role: 'lackey', suit: 'EXTRACTION', archetype: 'EXTRACTION lackey', hp: 50, alive: true, cardsExhausted: [] },
    },
    {
      id: 'mp-tag-lackey-emotion',
      label: 'Monster Party: Tag Alex-Jones-Bot (EMOTION)',
      tag: { role: 'lackey', suit: 'EMOTION', archetype: 'Alex-Jones-Bot', hp: 50, alive: true, cardsExhausted: [] },
    },
    {
      id: 'mp-tag-lackey-control',
      label: 'Monster Party: Tag Hasan-Piker-Bot (CONTROL)',
      tag: { role: 'lackey', suit: 'CONTROL', archetype: 'Hasan-Piker-Bot', hp: 50, alive: true, cardsExhausted: [] },
    },
    {
      id: 'mp-untag',
      label: 'Monster Party: Clear tag',
      tag: null,
    },
  ];

  for (const entry of entries) {
    try {
      await OBR.contextMenu.create({
        id: entry.id,
        icons: [
          {
            icon: 'https://grimgriz.github.io/monster-party-owlbear/extension-iframe/action-icon.svg',
            label: entry.label,
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
        onClick: (context) => {
          const items = context.items || [];
          // One-line diagnostic per click so we can see what OBR actually delivers.
          // Logs item count, first item's type/layer, and the tag we're about to write.
          const first = items[0];
          console.log(
            `[MP] ${entry.id} click → items=${items.length}` +
              (first ? ` first.type=${first.type} first.layer=${first.layer} first.id=${first.id}` : ' (no items)') +
              ` tag=${entry.tag ? entry.tag.role + ':' + (entry.tag.name || entry.tag.archetype || 'boss') : 'CLEAR'}`,
          );
          return writeTagToSelection(items, entry.tag);
        },
      });
    } catch (err) {
      console.error(`[MP] contextMenu.create(${entry.id}) failed:`, stringifyErr(err));
      log(`contextMenu.create(${entry.id}) failed: ${err?.message || err}`);
    }
  }
}

function defaultPcTag(name) {
  const hpByName = { Denny: 150, Beholda: 112, Rascal: 88, Goose: 81 };
  return {
    role: 'pc', name,
    hp: hpByName[name], maxHp: hpByName[name], ac: 14,
    bubbled: false, stunned: false,
    actionDiceAvailable: 4, specialsRemaining: 2, crystalsHeld: [],
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
  renderState();
  renderChain();
  renderHistory();
  renderRoundFinalizeVisibility();
}

function renderState() {
  const bs = currentBattleState();

  const pcList = $('pc-list');
  pcList.innerHTML = '';
  if (!bs.party.length) {
    pcList.innerHTML = '<div class="muted">No PC tokens tagged. Right-click a token in OBR → "Monster Party: Tag as …".</div>';
  } else {
    for (const pc of bs.party) {
      const flags = [];
      if (pc.bubbled) flags.push('BUBBLED');
      if (pc.stunned) flags.push('STUNNED');
      const className = `pc-name${pc.bubbled ? ' bubbled' : ''}${pc.stunned ? ' stunned' : ''}`;
      const row = document.createElement('div');
      row.className = 'pc-row';
      row.innerHTML = `
        <div class="${className}">${pc.name}</div>
        <div>${pc.hp}/${pc.maxHp}</div>
        <div>AC ${pc.ac}</div>
        <div>${pc.actionDiceAvailable}d</div>
        <div class="muted">${flags.join(', ')}</div>
      `;
      pcList.appendChild(row);
    }
  }

  const bossLine = $('boss-line');
  if (bs.boss) {
    bossLine.innerHTML = `<strong>Algorithm:</strong> ${bs.boss.hp} HP, AC ${bs.boss.ac}${bs.boss.tauntedTo ? ` · <span class="error">Taunted → ${bs.boss.tauntedTo}</span>` : ''}<span class="muted"> · exhausted: ${bs.boss.cardsExhausted.length}</span>`;
  } else {
    bossLine.innerHTML = '<span class="muted">No boss token tagged.</span>';
  }

  const lackeyList = $('lackey-list');
  if (bs.lackeys.length) {
    lackeyList.innerHTML = bs.lackeys
      .filter((l) => l.alive)
      .map((l) => `<div class="muted">▸ ${l.archetype} (${l.suit}, ${l.hp} HP)</div>`)
      .join('');
  } else {
    lackeyList.innerHTML = '';
  }

  $('state-display').textContent = JSON.stringify(bs, null, 2);
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
    const { system, messages } = buildVillainPrompt(bs, state.history);

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

  await OBR.scene.items.updateItems(state.items.map((i) => i.id), (drafts) => {
    for (const draft of drafts) {
      const tag = draft.metadata?.[METADATA_NAMESPACE];
      if (!tag || tag.role !== 'pc' || tag.name !== card.targetHero) continue;
      tag.hp = Math.max(0, (tag.hp || 0) - dmg);
      if (result === 'fail') tag.stunned = true;
      draft.metadata[METADATA_NAMESPACE] = tag;
    }
  });
}

function endRound() {
  const chain = state.pendingChain;
  if (!chain) return;
  const heroSummary = $('hero-summary').value.trim();

  const round = {
    round: chain.round,
    startHp: chain.startHp || null,
    chain: chain.chain.map((c) => ({
      order: c.order, suit: c.suit, cardName: c.cardName,
      targetHero: c.targetHero, result: c.result, skipped: !!c.skipped,
    })),
    chainBrokenAt: chain.chain.find((c) => c.result === 'save')?.order ?? null,
    monologueSummoned: chain.chainCompleted ? '(GM-typed lackey)' : null,
    heroActions: [],
    heroSummary,
  };

  state.history.push(round);
  saveHistory();

  // Append chain card names to boss.cardsExhausted via OBR if connected.
  appendExhausted(chain.chain.filter((c) => !c.skipped).map((c) => c.cardName)).catch(
    (err) => log(`exhausted update failed: ${err?.message || err}`),
  );

  // Bump round + clear chain
  state.overrides.round = (state.overrides.round || 1) + 1;
  $('ov-round').value = state.overrides.round;
  saveOverrides();
  state.pendingChain = null;
  savePendingChain();
  $('hero-summary').value = '';
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
  navigator.clipboard.writeText(text).then(
    () => setChainStatus('History copied to clipboard.'),
    (err) => setChainStatus(`Copy failed: ${err.message}`, true),
  );
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
  return [
    { id: 'mock-denny',   type: 'IMAGE', name: 'Denny',
      metadata: { [METADATA_NAMESPACE]: defaultPcTag('Denny') } },
    { id: 'mock-beholda', type: 'IMAGE', name: 'Beholda',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Beholda'), bubbled: true } } },
    { id: 'mock-rascal',  type: 'IMAGE', name: 'Rascal',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Rascal'),  bubbled: true } } },
    { id: 'mock-goose',   type: 'IMAGE', name: 'Goose',
      metadata: { [METADATA_NAMESPACE]: { ...defaultPcTag('Goose'),   bubbled: true } } },
    { id: 'mock-boss',    type: 'IMAGE', name: 'Algorithm',
      metadata: { [METADATA_NAMESPACE]: { role: 'boss', hp: 500, ac: 14, cardsExhausted: [], tauntedTo: false } } },
    { id: 'mock-lackey-emotion', type: 'IMAGE', name: 'Alex-Jones-Bot',
      metadata: { [METADATA_NAMESPACE]: { role: 'lackey', suit: 'EMOTION', archetype: 'Alex-Jones-Bot', hp: 50, alive: true, cardsExhausted: [] } } },
    { id: 'mock-lackey-control', type: 'IMAGE', name: 'Hasan-Piker-Bot',
      metadata: { [METADATA_NAMESPACE]: { role: 'lackey', suit: 'CONTROL', archetype: 'Hasan-Piker-Bot', hp: 50, alive: true, cardsExhausted: [] } } },
  ];
}
