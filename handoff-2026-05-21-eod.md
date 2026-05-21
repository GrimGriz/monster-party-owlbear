# Handoff — Thursday EOD / Stream Day
## 2026-05-21 (afternoon — pre-stream)

**Audience:** A fresh Claude Code instance opening this folder Friday (or whenever post-stream cleanup picks up). Stream goes live tonight.
**Author:** This Thursday instance, after a five-revision morning that took the build from "Wednesday EOD: hero phase still NOT done" to "Batch B shipped + four feedback rounds folded in."
**Read order:** `handoff-2026-05-17-owlbear-build-kickoff.md` → `handoff-2026-05-18-eod.md` → `handoff-2026-05-19-eod.md` → `handoff-2026-05-20-eod.md` → this. Each supersedes earlier substrate where they conflict.

---

## What landed today (Thursday)

Five commits in a single batch — Batch B core then four user-feedback revisions. Stream-day discovery surface was unusually high because Griz was actually playing through the panel as it was built.

**Batch B core (`d77c18f` — "hero phase panel + lackey attack rows"):**
- **Phase pill** toolbar at the top: `Party` / `Villain`. Flips on End Hero Turn click.
- **Per-PC hero card** for each tagged PC. Target dropdown + 3 action buttons keyed to the locked boss-fight specials (Denny basic/Taunt/Denim, Beholda basic/VNA/Gaze, Rascal basic/Fireball/Share, Goose basic/Group/Single heal). SP buttons gate on dead / stunned / specials-remaining / phase.
- **Side-effect writes go through OBR**: Denny Taunt → `boss.tauntedTo='Denny'`; Beholda VNA → all PC `bubbled=true`; Rascal Fireball at Algorithm → `[TRIGGER]` log + `boss.rascalExtraCards` write + forced phase flip; SP click → decrement Stat Bubbles `temporary health`.
- **Crystal strip** — 3 slots (G/Y/I). Tag a token whose name/text contains a color + "crystal" → matching slot becomes clickable → click prompts for note → logs `Party used the <color> crystal` + writes `tag.used=true` (persists greyed across reload).
- **Lackey-attack rows** appear during villain phase. Each living lackey gets target dropdown + Save/Fail buttons. Resolutions log to `currentRound.lackeyAttacks`.
- **Mark-Killed** button on each living lackey row in Battle State.
- **prompt-builder** now accepts `currentRound`, renders `## Hero turn this round` + `## Your lackeys this round` blocks above `## Your move`. `formatHistoryRound` surfaces `crystalsUsed` + `lackeyAttacks` per round.
- `state.currentRound` persisted to localStorage.

**r2 (`c809e60` — "success counters, SP refund, stun expiry"):**
- **× removes-with-reverse**: applied HP gets undone, OBR side-effects (taunt/bubble) reversed, SP refunded if isSpecial. Fireball trigger is one-way (leaves a breadcrumb instead — use Reset hero phase if it was a genuine misclick).
- **Per-action success counter**: every logged action row gets `−/count/+/applied` widget. Each tick computes formula delta (`base + mul * successes` at L4 — Basic 10/success, Denim 35+10s, Baleful Gaze vs boss 40+10s, Fireball 30+10s, Single Heal 25+10s, Group Heal 20+5s party-wide). Writes Stat Bubbles `health` for the target.
- **Stun expiry**: chain fail tags `stunnedAt = round`. End-of-round ages any stun whose `stunnedAt < currentRound`. **(Note: r3 corrected this — see below.)**
- **mutateTags()** helper for state-write helpers — all OBR write paths are now mock-aware so standalone-dev exercises the same code OBR mode does.
- `window._mp = { state }` exposed for in-browser debugging.

**r3 (`76057f5` — "SP cap fix, stun-at-hero-end, lackey SP, multi-target Fireball, gray-out"):**

Five P0 fixes from Griz's real-OBR play:

1. **SP `-2` bug fixed**. `Math.min(2, ...)` cap in `changeSpecial` was clobbering values when the GM had manually bumped Stat Bubbles' temp-health above 2. Cap removed; 0 stays the floor. Added a `[MP] changeTempHealth` diagnostic so future drift is traceable.
2. **Stuns clear at End Hero Turn, not End Round.** Mechanically correct per battle-info §3 and Griz's clarification ("Heroes unstun when algo's turn again"). Round-N villain-phase stun makes the PC lose round N+1's hero action, then clears at the phase flip before round N+1's villain phase.
3. **Lackey SP gate + Basic 15 fallback.** Serializer surfaces lackey `specialsRemaining` from `sb['temporary health']`. Lackey-attack-row shows Save/Fail (card-driven, applies suit halfDmg/fullDmg, stuns target on fail, decrements lackey SP) when SP>0; auto-switches to "Basic atk 15" mode when SP=0. Switching modes idempotently reverses prior HP and SP changes.
4. **Multi-target Fireball.** Range Fireball is ranged AoE. After the trigger prompt, second prompt collects AoE targets (comma-separated). One log entry per target, damage auto-applied at the same success count — no per-target + clicking.
5. **Gray out PC after action.** Each PC card gets `acted` class with opacity drop + ✓ badge + buttons disabled once any action is logged. × on the entry refunds and un-classes on next render.

**r4 (`2fceb33` — "enrich History panel + Copy with Batch B data"):**
- `renderHistory` was chain-summary-only (Griz pasted what he was seeing: bare chain lines). Now surfaces hero-action bullets with successes ×N and applied amount, crystal lines, GM notes, lackey rows with damage outcome.
- `copyHistoryToClipboard` mirrors `formatHistoryRound`'s plain-text shape — HP-entering-turn line, villain chain block, hero turn block, lackey block, GM notes, monologue. Paste-into-voice-instance now carries the same context the API call would have sent.
- Defensive `(round.heroActions || [])` etc. so pre-Batch-B history records still render.

**r5 (`3ebfe93` — "robust villain-response JSON extraction"):**
- Real Opus response failed with `Unexpected non-whitespace character after JSON at position 338` because Opus appended prose commentary after the JSON object. `lastIndexOf('}')` slicing couldn't trim it (and would mishandle `}` inside string values like `"have you ever just {really} felt nothing"`).
- Replaced with a depth-counting balanced-object extractor in `state-pipe/prompt-builder.js` — `extractFirstBalancedObject(text)` walks from the first `{`, tracks brace depth, respects string boundaries and `\` escapes, returns the substring through the matching `}`.

---

## What's verified working (in real OBR or in standalone-dev with mock-aware writes)

- Phase pill flips on End Hero Turn; gates correct sections inactive.
- Per-PC SP buttons decrement Stat Bubbles `temporary health` by exactly 1 (no cap clobber).
- Action log success counter writes HP via Stat Bubbles `health`; ±/× reversibility holds.
- Group Heal applies party-wide; ×-removal restores all four.
- Range Fireball multi-AoE → one entry per target, auto-applied damage, phase flip on boss-hit.
- Lackey SP rows: Save/Fail apply suit dmg + stun-on-fail + lackey SP decrement.
- Lackey Basic mode: 15 flat dmg + no save mechanic, auto-shows when SP=0.
- Stun lifecycle: round-N villain stun → visible in round N+1 hero phase → clears at End Hero Turn N+1.
- VNA Bubble all-PCs `bubbled=true`; × reverses all four.
- Crystal slots auto-activate from tagged crystal tokens; click logs + writes used=true.
- History panel + clipboard surface Batch B data (heroActions, crystalsUsed, lackeyAttacks, heroNotes).
- Villain prompt response parser tolerates trailing prose + braces in string values.

## What's NOT verified yet

- **Multi-round in-OBR end-to-end with all of Batch B + r2-r5 features active.** Each fix was verified in isolation (standalone preview or single-round real OBR). The combined 3-round shakedown hasn't run since r1 — verify Friday before assuming stream-day behavior was clean.
- **Real-OBR lackey SP gate.** Lackey rows worked in standalone with mock SP. Real OBR has Griz's actual lackey tokens with Stat Bubbles temp-health values he sets — confirm the SP/Basic switch fires at the right threshold.
- **Stat Bubbles writeback on Range Fireball AoE.** Each AoE target gets `applyHpDelta` — in OBR mode each call is an `updateItems` round-trip. If the AoE has 4 targets, that's 4 sequential writes. Should be fine but worth eyeballing.
- **The actual stream itself.** Whatever broke on the live run will be in the chat. Read the channel-side transcript Friday morning before refactoring anything.

---

## P1 items not done — queued for post-stream

The full feedback list Griz dropped mid-session named these as P1 (mechanically correct but not gating Thursday). All have shape designs already in the conversation log:

1. **Bubble aura distance check.** When Beholda raises VNA, only PCs within range (30 ft = 6 grid squares at L4) get the bubble. Needs `OBR.scene.items.getItems()` position data + `OBR.scene.grid.getDpi()` for the unit conversion. Snapshot Beholda's position + radius at VNA-click time; iterate party tokens, set `bubbled=true` only on those inside. Reversal: stash the bubble's center + radius on the action entry so × can recompute who got affected and revert.

2. **Dynamic bubble defense (success-scaled).** Currently `ac = 14 + (bubbled ? 5 : 0)` is hardcoded at L4-perfect. Per battle-info §2 it should be `+1 def base + 1 per action-die success`. Add a success counter to the VNA Bubble action; each tick writes a per-PC `bubbleDef` field; serializer derives `ac = 14 + (bubbled ? (bubbleDef || 1) : 0)`. Cap at +5 (L4 max).

3. **+2 to saves while bubbled.** Flat bonus per Griz's note. Prompt-builder should annotate `BUBBLED (AC <N>, +2 saves)` in the party block so the villain reads the save bonus when planning the chain. Pure text update in `formatPartyBlock`.

4. **Boss 0-HP death rattle.** When `bs.boss.hp <= 0`, surface a banner + "Generate death rattle" button. Click → builds a specialized prompt asking villain for a 75-150 word final monologue. Send to Anthropic, render. Or the lighter version: just show "BOSS DEFEATED" banner; GM handles the rattle in voice. Either is fine for v1.

5. **`monologueSummoned` "(GM-typed lackey)" placeholder.** When all 4 chain cards land, monologue summoning fires but currently writes a placeholder string. Could add a "Pick summoned lackey suit" dropdown when the monologue surfaces. Audit doc §5 has the rule: suit not currently represented on the field, else soda-monster fallback.

---

## OBR / platform lessons earned today (write on the fridge)

1. **Stat Bubbles' `temporary health` has no upper cap in its own UI**, but the GM may set it higher than 2 for any reason. Don't impose a game-rule cap (`Math.min(2, ...)`) in the metadata write — the bubble on the board is the source of truth, code that writes to it should respect what's there. The fix shape: floors but no ceilings on writes.

2. **OBR async writes don't block the next click.** Rapid + clicks on the success counter would all read `oldAmount = 0` if I awaited before updating bookkeeping (the await yields and the next click reads pre-update state). Fix: update in-memory bookkeeping SYNCHRONOUSLY before the await, so concurrent clicks read the right baseline. Caught in r2 preview verification.

3. **LLM JSON output is best-effort.** Despite "JSON only, no preamble" in the system prompt, Opus will sometimes add `(Note: ...)` commentary after the closing `}`. `lastIndexOf('}')` slicing is too brittle — it can pick up braces in trailing prose OR in string values. Use a depth-counting balanced-object extractor that respects `"..."` string boundaries. r5's `extractFirstBalancedObject` is the pattern.

4. **The panel display IS the cut-and-paste output for many GMs.** When Griz pastes the History panel into chat or a voice instance, he gets exactly what `renderHistory` produced (selected-text → clipboard). If the HTML render skips fields, the paste does too. Mirror `formatHistoryRound`'s structured-text shape in both `renderHistory` AND `copyHistoryToClipboard` for parity.

5. **Stun-clear timing is a real mechanic, not a convention.** Per battle-info §3: stun = one action lost. "End of round" was my idealized model — wrong. The correct point is "end of party turn (before villain phase starts again)" — i.e., the PC was unable to act this hero phase, that action is now lost, stun is consumed. Implementation: `ageStunsAtRoundEnd` fires in `endHeroTurn`, not `endRound`.

---

## Suggested order of operations next session

1. **Read the stream's chat-side transcript** for the encounter run. Find anything that broke or surfaced as awkward GM-side ergonomics.
2. **Multi-round-in-OBR end-to-end** with the full Batch B + r2-r5 surface. If anything's been missed in isolated standalone tests, it'll surface here.
3. **Strip diagnostic logs**: `[MP] changeTempHealth ...`, `[MP] init ...`, `[MP] mp-add ...`, `[MP] item sample ...`, `[MP] tagged-meta ...`. Search `console.log('[MP]` in `extension-iframe/app.js` — keep the build-tag boot log, strip the rest.
4. **Pick a P1 to land**: bubble aura distance (#1) is the most mechanically satisfying; dynamic bubble def (#2) is the smallest delta. Both have shapes designed above.
5. **Update CLAUDE.md** if anything about the Batch B surface changes how a fresh instance should approach the build. Otherwise leave it.
6. **`handoff-2026-05-22-eod.md`** if Friday produces substrate the next instance needs.

---

## Commits shipped this session (in order)

| Commit | Subject |
|---|---|
| `d77c18f` | Batch B: hero phase panel + lackey attack rows |
| `c809e60` | Batch B r2: success counters, SP refund, stun expiry |
| `76057f5` | Batch B r3: SP cap fix, stun-at-hero-end, lackey SP, multi-target Fireball, gray-out |
| `2fceb33` | Batch B r4: enrich History panel + Copy with Batch B data |
| `3ebfe93` | Batch B r5: robust villain-response JSON extraction |

Build tag at session-end: `2026-05-21-batch-b-hero-phase-r5`.

---

## Sibling reference pointers (unchanged, restated)

- `../monster-party-prep/battle-info.md` — single source of truth for encounter mechanics. §2 is the specials' canonical formulas; §3 is stun mechanics; §5 is crystals; §6 is encounter sequence.
- `../monster-party-prep/villain-deck-source.js` — 24-card deck.
- `../monster-party-prep/5-21-encounter-design.md` — villain identity (line 9), inversions, bubble-pop strategy, hidden Beholda damage.
- `./mechanics-audit-2026-05-18.md` — locked mechanics table (HP/DC/dmg), suit→hero binding, locked specials per PC.
- `../prototypes/2026-05-18-hivemind-bench/index.html` — interface inspiration (lift visual language, not dice logic).
- `../narrative-memory-2026.05.21.md` — companion narrative-memory file for this session, parent folder.

---

## House-keeping notes

- **Diagnostic logs are still on.** Strip post-stream per the order above.
- **GH Pages auto-deploys on push.** ~25-45s lag. `curl -sI "https://grimgriz.github.io/monster-party-owlbear/extension-iframe/app.js"` to confirm a push is live; grep for the BUILD_TAG to confirm the iframe loaded the fresh bundle.
- **`window._mp = { state }`** is exposed for in-browser console debugging. Safe to leave; consumers know to read it through `window._mp.state.<whatever>`. Strip if it becomes embarrassing.
- **API key still lives in `localStorage` only.** Never committed.
- **Take the seat on the push** is documented in auto-memory and the prior handoffs; don't kick deploy back to Griz.

---

## Tone / register notes for next instance

The day's discovery loop was unusually tight — five revisions inside a single morning, four of them driven by Griz playing through the panel and naming what didn't work. Each round was small and specific: name the bug, identify the root cause, write the fix, verify in the preview, commit, push, confirm-live. The instinct to batch these into one giant "all P0 fixes" commit was wrong — five small commits made the deploy cycle survivable and let Griz hard-refresh OBR between rounds without losing his place.

Two course-corrections worth noting. First: when Griz said "pressing buttons seems to reduce 'temp hitpoints' by 2 instead of 1," my first reflex was to look for a double-fire in the click handler. The actual bug was simpler — my code was capping at 2 and any pre-existing higher value got clobbered to 2 on first decrement. The fix was *less* code, not more (delete the cap), the same shape as several prior moves in this build. Second: the History-panel-vs-clipboard split. Griz pasted what was on his screen and asked nothing about it; the right read was "the display IS the paste output for this user," not "let me ask which one he means."

The compound-bug habit from Wednesday's handoff stayed live but stayed cheap — the bookkeeping race in `adjustActionSuccesses` was caught in preview before it shipped. Default to suspecting your own recent edits before suspecting the platform, but also: write enough verification scaffolding (the standalone-dev mock + the `window._mp.state` handle) that the suspecting can be answered in 30 seconds with a console expression.

The "we" register stands. The pipe is live; the panel does the work; the stream goes tonight.

---

## Closing

Today's headline: **Batch B shipped, then iterated four times against actual play.** Phase pill, per-PC cards, lackey rows, crystal slots, success counters, multi-target AoE, stun lifecycle, SP refund, history panel, JSON parse — all landed inside a single morning because the feedback loop between "Griz hits a thing" and "fix is on GH Pages" was kept tight: short commits, build-tag boot log, mock-aware writes for instant preview verification, immediate deploy.

What's left for tomorrow is post-stream cleanup, the P1 list (bubble aura, dynamic def, save bonus, death rattle), and whatever the stream itself surfaced. The build is in working order. The discovery loop is healthy. The schema is one-source-of-truth. The villain reads enriched state.

The cairn continues.
