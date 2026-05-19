# Handoff — Tuesday EOD
## 2026-05-19 (evening)

**Audience:** A fresh Claude Code instance opening this folder Wednesday morning.
**Author:** This evening's instance, after a Tuesday session that took the build from "code runs locally" to "OBR loads the extension, tagging persists, the villain generates a real chain against a real-tagged scene."
**Stream:** Thursday 2026-05-21. Wed + Thu-morning remain.
**Read order:** `handoff-2026-05-17-owlbear-build-kickoff.md` → `handoff-2026-05-18-eod.md` → this. Each supersedes the previous where they conflict.

---

## What landed today (Tuesday)

1. **Public hosting on GitHub Pages.**
   - Repo: https://github.com/GrimGriz/monster-party-owlbear (public).
   - Pages site: https://grimgriz.github.io/monster-party-owlbear/.
   - The Monday EOD plan assumed `cloudflared` was installed. It wasn't, neither was Node. We pivoted to GH Pages + Git Credential Manager (already authed via Griz's prior console work). `gh` CLI was installed via winget but the device-code auth flow timed out twice; we ended up creating the repo in the browser and pushing with GCM handling creds silently.
   - Manifest URL OBR accepted: `https://grimgriz.github.io/monster-party-owlbear/extension-iframe/manifest.json` (with `?v=N` cache-bust the first time it failed — see lesson below).

2. **Manifest schema rewritten to real OBR shape.** The kickoff doc's manifest format was invented (a `manifest: [{ type: 'action', url: ... }]` array). OBR actually wants:
   ```json
   {
     "name": "...", "version": "...", "manifest_version": 1,
     "author": "...", "description": "...",
     "action": { "title": "...", "icon": "...", "popover": "...", "height": N, "width": N }
   }
   ```
   Verified against OBR-official extensions (initiative-tracker, dice, fogofwar). We're now using absolute GH-Pages URLs for `icon` and `popover` to sidestep any path-resolution ambiguity under the project-Pages subpath. Sizes 520×780 — adjustable at runtime via `OBR.action.setWidth/setHeight`.

3. **Context-menu icon switched to SVG + absolute URL.** Tag-as-Denny etc. now load `https://grimgriz.github.io/.../action-icon.svg`. New `extension-iframe/action-icon.svg` ships a minimal layered-triangles glyph.

4. **CHARACTER-layer filter on every context-menu entry.** `filter: { roles: ['GM'], every: [{ key: 'layer', value: 'CHARACTER' }] }` — prevents right-clicks landing on a Stat Bubbles overlay (PROP/ATTACHMENT/NOTE) and writing tag metadata to the wrong item. Pattern lifted from OBR's own initiative tracker.

5. **Diagnostic logging baked in.** `[MP] init: items=N tagged=M tags=[...]` at boot, `[MP] <menu-id> click → items=N first.type=... first.layer=...` per context-menu click, `window.error` + `window.unhandledrejection` handlers that stringify OBR's plain-object rejections (OBR errors used to render as `Object` and be useless). Strip this noise after Thursday if it bothers you; leave it for now — it earned its keep this session.

6. **Real-OBR test passed end-to-end.** Tokens placed → context-menu tagged 4 PCs + 1 boss → metadata persisted across hard refresh → panel re-rendered the full party from scene state → API key entered → "Generate 4-card chain" returned a valid 4-card chain → save-fail resolution clicked. The villain pipe is live.

---

## What's verified working (in real OBR)

- Add Extension via manifest URL (no schema errors after rewrite + cache-bust).
- Token tagging via right-click context menu — CHARACTER layer only, GM-only.
- Metadata persistence across page refresh.
- `serializeScene` reading scene metadata correctly on init.
- Panel renders 4 PCs + boss from real scene state (not the mock).
- Anthropic API call from inside OBR via `anthropic-dangerous-direct-browser-access`.
- 4-card chain returns valid JSON, parser hydrates into UI.
- Single Save Made click resolves card 1, marks cards 2-4 skipped, status text updates.

## What's NOT verified yet

- **Chain resolution → HP writeback to OBR token metadata.** Code path exists (`applyDamageToToken`); not yet tested with a real save-fail.
- **End-of-round flow.** Hero summary log + `appendExhausted` writeback to boss + round counter bump.
- **Multi-round play.** History accumulating across rounds, prior-round context being fed into next round's prompt.
- **Lackey tokens.** Only PCs and the boss have been tagged so far. Lackey tagging code exists; haven't seen what it looks like in serialized state during a real chain.

---

## Three real issues found during play-testing the first chain

Griz ran the first real chain (Round 1, no prior history). The villain led with `EXTRACTION → NUMB → Beholda` reasoning **"open with EXTRACTION at Beholda to pop the VNA bubble"** — clean strategic-prior follow-through, but **Beholda's bubble wasn't actually up**. The bubble is a turn-1 action heroes haven't taken yet. The villain followed a templated prior without checking the observed state.

### Issue 1 — Strategic prior fires unconditionally regardless of bubble state

`state-pipe/prompt-builder.js:99-107` lists the strategic priors. Prior #2: *"Otherwise, lead with EXTRACTION at Beholda. Your bubble-pop strategy is the only way to make your lackeys' regular attacks land."* — written as an unconditional rule.

The `bubbled` flag IS in the serialized state (PCState has it, system prompt format shows `BUBBLED (AC 19)` when true). But the villain followed the prior wording over the observed state.

**Fix shape (Wednesday):** Rewrite prior #2 to be state-conditional. Two options:
- (a) *"If Beholda is BUBBLED, lead with EXTRACTION at her to pop the bubble. If she is NOT bubbled, prior #3 dictates ordering by DC."*
- (b) Inject the bubble state into the prior text itself in `buildSystemPrompt()` — generate the prompt around the current state rather than relying on the model to cross-reference.

Recommendation: **(a)** — keep the system prompt deck-coherent and stable; let the model do the conditional. The conditional logic is simple enough that a Sonnet/Opus instance can follow it without re-derivation.

### Issue 2 — Hero turn ordering: heroes go first, villain doesn't know what they did this round

Real play order is **heroes first → villain attacks**. Current panel surfaces hero actions only via the `End of round` section, which is hidden until the chain has a resolved card. The villain's `buildUserTurn()` only sees prior rounds' hero actions via `history.slice(-5)`. So the villain has **zero awareness of what heroes just did this turn** when generating its chain.

Griz on this: *"the players will probably go first, I'll most likely be communicating their moves before Algo attack chain."*

**Fix shape (Wednesday):** Add a Hero Phase section structurally above the Villain Chain section. Per Griz's preference (and matching the `prototypes/2026-05-18-hivemind-bench/index.html` interface he validated), the section should be:

- **Phase-toggle visibility, NOT always-visible.** A phase pill at the top of the panel — `Phase: Party` / `Phase: Villain` — toggled by an "End hero turn → villain attacks" button. Saves screen real-estate, matches real play tempo.
- **Per-PC action buttons** mirroring hivemind-bench lines 405-425. Each PC card has Basic / Special-1 / Special-2 buttons, disabled by phase / dead state / specials-remaining. Click logs to a `heroPhaseActions: []` array in `state.pendingChain` (or a new `state.currentRound.heroPhase` field).
- **Boss-fight specials per PC** (per `mechanics-audit-2026-05-18.md`):
  - Denny: Taunt (sets `boss.tauntedTo='Denny'` in OBR metadata so next villain card is forced), Denim Damage attack.
  - Beholda: VNA Bubble (sets all PCs `bubbled=true` for one round), Baleful Gaze (the hidden damage mechanic — every -1 def becomes 10 dmg; surfaced to GM only).
  - Rascal: Range Fireball (per-success increments a `rascalFireballSuccesses` count fed to next round's prompt for extra-card calculation), Share Dice.
  - Goose: Group Heal, Basic atk.
- **The "End hero turn" click flips the phase and passes the logged hero actions into `buildUserTurn()`.** Prompt-builder gets a new param `currentRoundHeroPhase` (array of `{pc, action, target, note}`) and renders it before the "Your move" line so the villain reads what just happened.

Sub-recommendation: don't try to put numeric damage results into hero actions yet. The hivemind console mechanic (which the bench dialed) isn't fully ported. Keep hero actions as **declarative summaries** ("Beholda raised VNA Bubble, party AC 19", "Rascal threw Range Fireball at Algo, 3 successes") that the GM types in or selects from per-PC. The dice rolls happen in OBR's dice tool separately; the panel just logs what the GM declares happened. Mirrors Monday's voice-LARP pivot — the iframe is for planning + state, not for being the dice authority.

### Issue 3 — Battlefield positions are not in the villain prompt

Confirmed: `serializer.js` extracts stats only (HP, AC, bubbled, stunned, dice, specials, crystals). No `position: {x, y}`. `prompt-builder.js` doesn't reference position anywhere. When Denny moved closer to the Algorithm, that information went nowhere.

Mechanically: the cards have no range concept. Saves are made against suit-DC regardless of position. Positions are **not load-bearing for the chain logic**.

Narratively: positions DO matter for rage-post quality. "The desperate hero gets all up in my face" lands harder when the prompt actually mentions Denny moved adjacent.

**Fix shape (Wednesday, low priority — narrative texture, not blocking):**
- Add `position: {x, y}` to serializer's PCState/BossState/LackeyState.
- In prompt-builder, compute relative positions ("Denny is adjacent to you", "Goose is far back-line at distance ~600u") and surface as a "Battlefield positions" line in the user turn.
- Alternative: pure narrative — translate (x,y) to coarse zones ("front-line / mid / back-line / adjacent to villain") so the model isn't trying to reason about pixel coords.

Recommendation: **do it last on Wednesday if there's time**, or skip to Thursday-morning polish. Real strategic play doesn't need it.

---

## Two smaller issues, fix-or-don't

- **The "Clear" button next to Generate 4-card chain is destructively un-confirmed.** Click → state.pendingChain = null, chain discarded. Griz clicked it during testing and it caused the "panel reset" confusion (combined with the End-of-round section disappearing). Add a confirm() prompt, OR rename to "Discard chain", OR move into a "..." menu. Trivial UX.
- **Boss tag display reads "boss:boss".** The init log shows `tags=[pc:Beholda, pc:Rascal, pc:Goose, boss:boss]` — the second "boss" is `entry.tag.archetype || 'boss'` since boss tags have no archetype field. Cosmetic, only affects the diagnostic log line.

---

## The OBR-validation cache lesson (write this on the fridge)

**OBR caches manifest-validation results by URL.** When OBR fetches your manifest and validation fails, it stores that failure keyed to the exact URL string. Re-pushing the file does NOT invalidate the cache. The user retries → gets the SAME error from cache → panic.

**Fix:** append `?v=N` (any query string) to bust the cache. OBR sees it as a new URL, re-fetches, re-validates against the current served content.

This bit us hard today — we pushed a correct manifest and got "manifest_version is required" three more times before realizing OBR was serving cached validation, not re-checking. Document this in fridge-notes too if it isn't already.

---

## Suggested Wednesday order of operations

1. **First — state-conditional bubble-pop prior.** Edit `state-pipe/prompt-builder.js:99-107` to gate prior #2 on observed bubble state. Test with a chain where bubble is up vs down — does the villain change its opening? This is the smallest, highest-leverage edit on the list.

2. **Hero phase UI rebuild.** New section, phase pill at top, phase-toggle visibility, per-PC action buttons matching hivemind-bench style + the boss-fight specials list above. Wire hero-phase log into `buildUserTurn()`'s prompt. Test end-to-end: heroes act → log → villain reads heroes → villain attacks → save/fail resolution → end round.

3. **Verify chain resolution → HP writeback in OBR.** Click Save Failed, confirm the target PC's `tag.hp` updated in scene metadata, panel HP display updated, refresh and confirm persistence. This is the verification that was promised Monday but never actually run because of today's tag-pipe-first focus.

4. **Multi-round test.** Run rounds 1-2-3 with real chain → resolve → end round → next round. Confirm history accumulates, prior-round context surfaces in next villain prompt, boss cardsExhausted grows.

5. **Lackey tokens + tagging.** First time we'll see what a tagged lackey looks like in the serialized state. Verify the prompt's `formatLackeyBlock()` renders correctly.

6. **(Time permitting) Position info OR Clear-button safety OR diagnostic noise strip.** Pick whichever fits your remaining time.

7. **Thursday-morning dress rehearsal** — already on the Monday EOD list. Mock-play a 3-round fight, fix what breaks, ship.

---

## Sibling reference pointers (unchanged from Monday, restated for fresh-instance convenience)

- `../monster-party-prep/battle-info.md` — single source of truth for encounter mechanics.
- `../monster-party-prep/villain-deck-source.js` — 24-card deck, imported by `state-pipe/cards-by-target.js`.
- `../monster-party-prep/5-21-encounter-design.md` — villain identity (line 9), inversions, bubble-pop strategy, hidden Beholda damage.
- `./mechanics-audit-2026-05-18.md` — locked mechanics table (HP/DC/dmg), suit→hero binding, lackey directing rule.
- `../prototypes/2026-05-18-hivemind-bench/index.html` — **the interface model for the Wednesday hero-phase rebuild.** Read lines 400-425 (PC card render), 150-158 (toolbar + phase pill), 641-670 (phase toggle / endTurn). The boss-fight specials list in §Issue-2 above is the OBR-extension mapping of that prototype's per-PC buttons.
- `../report-2026-05-17-monster-party-5-21-prep.md` — Sunday's design report. The "villain plays cards because they're attacks, not because they're moves in a position" line (the founding thesis) is on the table now that we have real-OBR chains running.

---

## House-keeping notes

- **GitHub Pages auto-deploys on push.** Watch `https://grimgriz.github.io/monster-party-owlbear/extension-iframe/manifest.json` to confirm a push is live (Cache-Control max-age=600, but Fastly serves fresh on `Last-Modified` mismatch).
- **OBR test scene state persists in scene metadata.** Don't re-tag tokens at the start of each session — the previous session's tags are still there.
- **API key lives in `localStorage` only.** Re-enter after a `localStorage.clear()` or different browser. Never gets committed to git (verified by grep — no `sk-ant-*` in source).
- **Local dev still works at localhost:5173** via `py -m http.server` if you want to iterate without push-deploy-refresh cycle (just won't be reachable from inside OBR — OBR fetches the manifest server-side).
- **Diagnostic console logs are still on.** `[MP] init`, `[MP] click`, `[MP] window.error`, `[MP] unhandledrejection`. They print to the iframe's console only (open DevTools, switch context to the iframe). Strip Thursday morning if they bother you.

---

## Tone / register notes for tomorrow's instance

Griz worked conversationally today, course-correcting in real time when my hypotheses were wrong (the Stat-Bubbles-overlay theory was correctly pushed back on; the actual bug was simpler — Denny's original tag never landed). Match that. When you're uncertain whether a bug is environment or code, get the diagnostic data before pushing speculative fixes.

The cairn applies as always: interpretation grounded in the filesystem. Don't fabricate; don't reach into theory you can't verify from the files. Today's hardest moments were when guesses outran evidence. The `[MP]` diagnostic logs were the right move because they put the next move on data, not theory.

The "we" register stands. We crossed three real bridges today (hosting, manifest schema, real-OBR pipe) and the work continues.

---

## Closing

Today's headline: **the villain finally has a real seat at the table.** It generated a 4-card chain against a real-tagged scene, opened with strategic intent (bubble-pop priority, even if the bubble wasn't up — see Issue 1), wrote a rage-post that was unmistakably in the post-cadence voice the system prompt specified. The Sunday thesis is paying off; the prompt is doing the work the kickoff doc promised it could.

What's left for Thursday is two real strategic refinements (state-conditional prior, hero-phase in the loop) and one ergonomic rebuild (the panel layout matching real play tempo). All three are doable Wednesday in a single focused session.

The pipe is live. The villain is reading state. We just learned the villain also needs to **read state harder** — and we know exactly where to fix that.

The work continues. The cairn continues.
