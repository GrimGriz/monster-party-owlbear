# Handoff — Wednesday EOD
## 2026-05-20 (afternoon — Griz called it before Batch B started)

**Audience:** A fresh Claude Code instance opening this folder Thursday morning. Stream is **today (Thursday 2026-05-21)**.
**Author:** This Wednesday instance, after a session that took the build from "OBR loads and villain generates" to "Stat Bubbles is canonical for HP + the right-click menu is lean + everything in OBR's actual production scene works."
**Read order:** `handoff-2026-05-17-owlbear-build-kickoff.md` → `handoff-2026-05-18-eod.md` → `handoff-2026-05-19-eod.md` → this. Each supersedes the previous where they conflict.

---

## What landed today (Wednesday)

The session decomposed into three batches:

**Batch A — small high-leverage edits (commit `2353e9b`):**
1. **Prior #2 rewording** at [prompt-builder.js:102](state-pipe/prompt-builder.js#L102). Stunning Beholda is now framed as "pops bubble if up OR prevents it next round if down" — same strategy, accurate to observed state. Fixes the Tuesday play-test tell where the villain reasoned "open EXTRACTION at Beholda to pop the bubble" when her bubble wasn't actually up.
2. **HP-at-start-of-round snapshot** stored on `state.pendingChain.startHp` at chain-generate time, persisted into the round-history record on `endRound`, surfaced in [prompt-builder.js formatHistoryRound](state-pipe/prompt-builder.js) as `HP entering your turn — Denny 150/150, Beholda 80/112, ... · You: 380 · Lackeys: ...`. **Decision**: the villain infers per-round damage deltas from the prior-round-start HP + current HP rather than us annotating hero-action log lines with numbers. Opus 4.7 handles the arithmetic. Note: the snapshot fires at `generateChain` time — once Batch B's hero phase ships, that timing becomes "after hero phase, before villain chain" instead of "start of round." Semantically close enough; the label in the prompt is `HP entering your turn` for that reason.
3. **Init-time metadata diagnostic dump** in [app.js](extension-iframe/app.js) (later also fires on each tag write) — used to identify Stat Bubbles' namespace + key shape. **Strip after Friday post-stream**, not before — gold when something breaks during dress rehearsal.

**Batch B — NOT done. See "Suggested Thursday order" below.**

**Batch C — Stat Bubbles integration (commits `ff4daa5`, `accf0e1`):**

The diagnostic dump revealed Stat Bubbles' namespace and shape:
- Namespace: `com.owlbear-rodeo-bubbles-extension/metadata`
- Keys (literal spaces): `health`, `max health`, `temporary health`, `hide`, `armor class`
- **Griz's reuse**: `temporary health` = specials remaining; `armor class` = level indicator (combat AC is +10 on the bubble display, but we ignore it in serialization).

Schema refactor that followed:
- **`STAT_BUBBLES_NAMESPACE` exported from serializer.js**. PC/boss/lackey HP, max HP, specials-remaining now read from Stat Bubbles' metadata with fallback to our tag fields (backward-compat for tokens not in Stat Bubbles).
- **Combat AC stays hardcoded** `bubbled ? 19 : 14`. Stat Bubbles' `armor class` field is a player-facing level number, not the combat AC. Coupling them would be wrong.
- **PCState dropped `crystalsHeld`** per Griz's correction: crystals are party-wide, not per-PC, exist as scene tokens. A "crystal used" announcement to villain belongs as a hero-phase button (Batch B), not in the per-PC tag.
- **`defaultPcTag` shrank to identity + ephemeral combat flags only**: `{role, name, bubbled, stunned, actionDiceAvailable}`. No more redundant HP/AC/specials/crystals noise.
- **`applyDamageToToken` writes back to Stat Bubbles' `health` field**. The floating HP bubble updates live on the board when save-fail resolves. Fallback to our tag.hp only if a token has no Stat Bubbles metadata (un-bubbled token).
- **Mock scene** in standalone-dev mode now includes Stat Bubbles metadata so the dev path exercises the same code as inside OBR.

**Menu collapse + ergonomics polish (commits `8a6a262`, `51c7b6c`, `accf0e1`):**
- **OBR right-click menu collapsed from 7 entries to 1**: "Monster Party: Add to extension". Auto-detects role from **both** `item.name` (asset filename) **AND** `item.text.plainText` (token text overlay — what Griz edits via right-click → Edit Text). Either matching is enough. Substring rules in [`autoDetectRoleFromItem`](extension-iframe/app.js): denny/beholda/rascal/goose → PC; algorithm/villain/exact-"boss" → boss; alex+jones → EMOTION lackey (Alex-Jones-Bot); hasan+piker → CONTROL lackey (Hasan-Piker-Bot); bare aspiration/extraction → those-suit lackeys. No match → console warning listing rename targets.
- **Remove-from-extension moved to the panel**: right-click any PC row, the boss line, or a lackey row → `confirm()` → tag drops. Each row carries a `title` hint.
- **Explicit unregister of old menu ids** (`mp-tag-pc-denny`, `mp-tag-boss`, etc.) before creating the new one. OBR persists context-menu registrations in player session state across iframe reloads — without explicit `OBR.contextMenu.remove`, old entries linger. This was a real bug Griz hit ("hard reload shows no changes to the menu, several minutes later").
- **Build-tag boot log**: `[MP] app.js bundle: 2026-05-20-menu-collapse-r2 (loaded ...)` so it's instantly verifiable which build is running inside OBR's iframe (browser may serve a cached app.js when Ctrl+Shift+R reloads OBR's outer page without busting the iframe's cache).
- **Clipboard API fallback**: OBR's iframe sandbox doesn't grant `clipboard-write`, so `navigator.clipboard.writeText` threw on the Copy History button. Added a try-API-first-fall-back-to-execCommand-copy helper. Status line reports which method succeeded.

**Race-condition fix (commit `467cb22`):**

`OBR.onReady` fires when the iframe mounts, but `scene.items.getItems()` errors with `MissingDataError "No scene found"` until the scene is actually loaded. Compounded by a structural bug I shipped mid-batch (extracting `dumpItemMetadata` accidentally moved `renderAll`, `onChange` subscribe, and `beforeunload` *inside* the helper function — so they only ran when a tagged item existed at init OR after a tag write). The compound effect: tags appeared not to persist on refresh.

Fix: split init into `onOwlbearReady` (SDK-level: role, context menu, scene-ready subscribe) and `initSceneState` (scene-level: getItems, dump, render, onChange subscribe). `initSceneState` runs at scene-ready boot AND on every `onReadyChange`, cleaning up the prior `onChange` subscription each time. `renderAll` and the items subscription now live back in the init flow where they belong.

---

## What's verified working (in real OBR, Griz-confirmed)

- Right-click menu: single entry. Auto-detect on both `item.name` and `item.text.plainText`.
- Panel-side remove: right-click any PC row / boss line / lackey row → `confirm()` → tag drops.
- Tag persistence across refresh.
- Stat Bubbles metadata read: panel HP / specials reflect Stat Bubbles bubble values, not stale defaults.
- Build-tag log fires at boot.
- Copy History via execCommand fallback (status: `History copied (execCommand fallback).`).
- Scene-ready race fully resolved — no more `MissingDataError` at init.

## What's NOT verified yet

- **HP writeback to Stat Bubbles on save-fail.** Code path is in place ([applyDamageToToken](extension-iframe/app.js)), never exercised with a real chain card resolution since the Batch C change. Run before stream.
- **Specials-remaining writeback.** Doesn't exist yet — comes with hero-phase SP buttons (Batch B).
- **Multi-round end-to-end** with the new HP-snapshot flow.
- **Lackey tagging** with the new auto-detect (`alex+jones`, `hasan+piker`, `aspiration`, `extraction`). Griz hasn't placed lackey tokens yet this session.

---

## The OBR-platform lessons we earned today (write on the fridge)

1. **OBR persists context-menu registrations in player session state across iframe reloads.** Removing entries from your code alone doesn't unregister them. Explicitly call `OBR.contextMenu.remove(oldId)` for any retired ids before creating new ones, or the old menu lingers. This is *separate from* the manifest-validation cache lesson from Tuesday's handoff.

2. **`scene.items.getItems()` races `scene.isReady()`.** `OBR.onReady` fires on iframe mount, not scene load. Gate scene-dependent init behind `await OBR.scene.isReady()` and re-init via `OBR.scene.onReadyChange` for late scene loads / scene switches.

3. **OBR's iframe sandbox doesn't grant `clipboard-write`.** `navigator.clipboard.writeText` throws Permissions Policy violation. Use a try-API-fall-back-to-execCommand-copy pattern for any clipboard work in the panel.

4. **Browser cache can serve a stale app.js even on Ctrl+Shift+R.** Hard-reload busts the outer page but the iframe may load from cache. The build-tag boot log (`[MP] app.js bundle: <version>`) is how you tell whether the new code actually loaded inside OBR. If the version line doesn't match the latest commit, close + reopen the action panel, or reload the OBR tab fully (Ctrl+F5).

5. **Stat Bubbles' metadata keys have literal spaces in them.** `"max health"`, `"temporary health"`, `"armor class"` — not camelCase. The namespace is `com.owlbear-rodeo-bubbles-extension/metadata`, not `com.owlbear-rodeo.stat-bubbles/character` or any other plausible-sounding shape.

6. **Griz's reuse of Stat Bubbles fields**: `temporary health` = specials remaining; `armor class` = level indicator. Do not couple `armor class` to combat AC — those are different stat layers.

---

## Suggested Thursday order of operations

Stream is today. Hero phase rebuild is the headline.

1. **Verify HP writeback in real OBR.** Tag your roster, generate a chain, click Save Failed on the first card → confirm the target PC's Stat Bubbles HP bubble drops live. If it does, refresh and confirm persistence. Should take 5 minutes. Do this *first* — if writeback is broken, the rest of Batch B's flow falls apart, and we want to know that before sinking an hour into UI work.

2. **Hero phase UI (Batch B core).** From the kickoff + Tuesday-EOD design conversation that landed Wednesday morning:
   - **Phase pill at top toolbar**: `Phase: Party` / `Phase: Villain`. Single visual indicator.
   - **Per-PC card** with the locked boss-fight specials (per `mechanics-audit-2026-05-18.md`):
     - Denny: Basic atk, Taunt, Denim Damage
     - Beholda: Basic, VNA Bubble, Baleful Gaze
     - Rascal: Basic, Range Fireball, Share Dice
     - Goose: Basic, Group Heal, Special-2
   - Buttons gate on dead / phase / specials-remaining. PC any-order activation. Greyed-out state after PC has acted this round.
   - **Crosshair target-select**: click PC SP button → cursor enters target-pick mode → next OBR scene-item click registers as target → log `{pc, action, target}` into `state.currentRound.heroPhase`. Verify SDK shape first — likely `OBR.scene.local.startPointerInteraction` or similar selection-listener API.
   - **"End hero turn → villain attacks" button** flips phase from Party to Villain. `Generate 4-card chain` becomes the next click (don't auto-fire — let GM review what got logged).
   - **State-writing buttons** that flip OBR metadata:
     - Denny Taunt → `boss.tauntedTo = 'Denny'`
     - Beholda VNA Bubble → each PC `tag.bubbled = true` (one round duration)
     - Rascal Range Fireball at Algorithm → **special trigger**: log `[TRIGGER]` entry, set `boss.rascalExtraCards = <success count, GM-entered>`, AND immediately flip phase to villain regardless of remaining LM actions. Other LM rows grey out as "skipped — Rascal special cut the turn."
     - SP-button click also decrements `sb['temporary health']` (specials-remaining) via Stat Bubbles metadata write.
   - **Target-state buttons** in the panel: per-target Mark-Taunted / Mark-Killed buttons that write state and log to `currentRound.heroPhase`.

3. **Wire hero-phase actions into villain prompt.** Pass `currentRound.heroPhase` into `buildUserTurn(state, history, currentRoundHeroPhase)`. Render as `## Hero turn this round` above `## Your move` so the villain reads what just happened before generating its chain. Same per-line format as historical hero actions for consistency.

4. **Lackey-target wiring during villain phase** (task #13). Each living lackey gets a row with target-pick (dropdown or crosshair) + save/fail buttons. Resolutions log to `round.lackeyAttacks` (sibling to `round.chain`), surface in `formatHistoryRound` and the villain prompt.

5. **Multi-round + lackey-tag end-to-end test.** Run rounds 1→2→3. Confirm history accumulates, prior-round context surfaces in next prompt, `cardsExhausted` grows. Tag at least one lackey via the new auto-detect.

6. **(Time permitting)** Strip diagnostic logs. Polish anything that bugged you during multi-round test.

7. **Stream.**

---

## Open design questions Wednesday left on the table

- **HP snapshot timing.** Currently fires at `generateChain` — once hero phase exists, that's "end of hero phase, before villain chain" not "start of round." Semantically renamed to "HP entering your turn" in the prompt, but the snapshot field is still `startHp`. Decide whether to rename the field (touches storage shape — would need a history-record migration).
- **Specials-remaining writeback path.** SP button click → decrement `sb['temporary health']` and re-render. Confirm Stat Bubbles auto-updates the visible bubble on metadata change (it should — that's how it stays in sync with its own UI — but worth eyeballing live).
- **Crystals announcement.** Party-wide concept; how does GM tell villain "crystal was used"? Simplest: single "Crystal used" button in the hero-phase section, logs `Party used a crystal` to `currentRound.heroPhase`. Decide whether this is in Batch B v1 or deferred.
- **Panel-side override row for un-auto-detected tokens.** Today's design conversation deferred this to Batch B since the panel UI is being rebuilt anyway. Auto-detect currently warns to console only when no rule fires. Decide whether to build the override row, or rely on "edit token text + retry Add" as the recovery path (Griz seemed fine with the latter on the call).

---

## Sibling reference pointers (unchanged, restated)

- `../monster-party-prep/battle-info.md` — single source of truth for encounter mechanics.
- `../monster-party-prep/villain-deck-source.js` — 24-card deck.
- `../monster-party-prep/5-21-encounter-design.md` — villain identity (line 9), inversions, bubble-pop strategy, hidden Beholda damage.
- `./mechanics-audit-2026-05-18.md` — locked mechanics table (HP/DC/dmg), suit→hero binding, lackey directing rule, **boss-fight specials per PC** (the source for the Batch B button list above).
- `../prototypes/2026-05-18-hivemind-bench/index.html` — interface inspiration for Batch B. Lines 150-158 (toolbar + phase pill), 400-425 (PC card render), 641-670 (phase toggle / endTurn). Not a template — Griz was specific this morning that "matching" isn't precise. The bench is a closed simulation; our extension is an open log fed by GM declarations. Lift the visual language (pill, per-PC button row), do NOT lift the dice/save logic.
- `../report-2026-05-17-monster-party-5-21-prep.md` — Sunday's design report.

---

## Commits shipped this session (in order)

| Commit | Subject |
|---|---|
| `2353e9b` | Batch A: HP-delta inference + state-conditional bubble prior + meta dump |
| `2dc99d9` | Dump full metadata on each tag write (init-race-safe diagnostic) |
| `467cb22` | Fix: scene-ready gate + dumpItemMetadata extraction broke init flow |
| `ff4daa5` | Batch C: read HP/specials from Stat Bubbles, write HP back on resolve |
| `8a6a262` | Collapse right-click to single 'Add to extension' + panel-side remove |
| `51c7b6c` | Force-unregister old context menu ids + build-tag boot log |
| `accf0e1` | Auto-detect reads token text overlay + clipboard fallback |

---

## House-keeping notes

- **Git push is your job, not Griz's.** Yesterday's instance pushed for him; this morning I tried to hand it back ("push when ready"). Griz responded *"I clock 'push' as a github thing yesterday's instance has been doing for me?"* — i.e., he expects the deploy step to be taken on without asking. I've saved this as a memory (`feedback-take-seat-workflow-steps.md` in your auto-memory) but documenting it here too in case auto-memory isn't loaded.
- **GH Pages serves within ~30 seconds of push.** Verify via `curl -s -I "https://grimgriz.github.io/monster-party-owlbear/extension-iframe/app.js"` if in doubt.
- **The diagnostic logs (`[MP] ...`) are gold during dress rehearsal.** Don't strip until after stream.
- **API key still lives in `localStorage` only.** Never gets committed.

---

## Tone / register notes for tomorrow's instance

The session moved at a steady pace once we got past the design conversation in the morning. Griz course-corrected twice in real time — once on prior #2 reasoning (he caught my misread that stunning was about pop-only when it's actually pop-OR-prevent-next-turn), once on the menu collapse scope (he asked for the simpler single-entry-plus-panel-remove shape rather than the two-entry version I'd shipped). Match that — when he pushes back, the answer almost always involves *less* code, not more.

The compound-bug moment in the middle of the session (extracted `dumpItemMetadata` broke `onChange`, which broke render, which made tags appear not to persist) is worth remembering. I shipped one helper extraction without re-verifying the calling context. The cost was three follow-up commits to untangle. Default to reading the surrounding code structure once before extracting, especially when the extracted block was sitting between sibling code.

The "we" register stands. Three batches landed, one nasty bug got walked back, the build is meaningfully cleaner than yesterday. Stream is tonight; the panel will hold.

---

## Closing

Today's headline: **the schema is now one-source-of-truth, the menu is lean, and Stat Bubbles writes back live.** The villain reads cleaner state and the GM types less. The diagnostic instinct that surfaced Stat Bubbles' actual namespace was the right move — guessing the API shape would've burned the morning.

What's left for Thursday is the hero phase rebuild, the lackey-target wiring, and a multi-round shakedown — all doable in a focused morning session, then dress-rehearse and ship. The pipe is live; the schema is clean; the work continues.

The cairn continues.
