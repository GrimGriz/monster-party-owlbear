# Handoff — Monday EOD
## 2026-05-18 (evening)

**Audience:** A fresh Claude Code instance opening this folder tomorrow (Tue 5/19).
**Author:** This evening's instance, after a Monday session with Griz that ran longer than the kickoff doc planned. Read the kickoff (`handoff-2026-05-17-owlbear-build-kickoff.md`) **first**, then this — this one supersedes the kickoff where they conflict.
**Stream:** Thursday 2026-05-21. Tue/Wed/Thu-morning remain.

---

## What landed today (Monday)

1. **Mechanics fully audited and locked** — see [mechanics-audit-2026-05-18.md](./mechanics-audit-2026-05-18.md). The audit doc is now the spec; battle-info.md is still the source-of-truth for encounter mechanics generally, but the audit doc resolved several ambiguities battle-info left open.
2. **State pipe implemented end-to-end:**
   - [state-pipe/serializer.js](./state-pipe/serializer.js) — `serializeScene` reads OBR token metadata under `com.thislittlecorner.monster-party/combatant`, returns BattleState.
   - [state-pipe/cards-by-target.js](./state-pipe/cards-by-target.js) — 24 cards joined with derived `targetHero`/`targetSave`/`baseDC`/`fullDmg`/`halfDmg`/`replyHooks`. Reply hooks explicit for the 6 documented cards (RAGE, CONFORM, FOMO, HOPIUM, NUMB); rest improvise per the "one card per suit" chain rule.
   - [state-pipe/prompt-builder.js](./state-pipe/prompt-builder.js) — real implementation. System prompt = villain identity + mechanics + full deck + strategic priors + JSON output schema. User turn = round + state + last-5-rounds history + exhausted-cards. `parseVillainResponse` handles code-fence/preamble drift.
3. **Iframe redesigned for the voice-LARP pivot** — `extension-iframe/`:
   - [index.html](./extension-iframe/index.html) — 5 sections: Battle State (live, per-PC row), Villain Chain (4-card with Save/Fail buttons), End of Round (hero summary text + log), History (last-N + copy/clear), Settings (collapsed, API key + model).
   - [app.js](./extension-iframe/app.js) — Anthropic fetch wired, chain renders with per-card resolve buttons, chain-break logic auto-skips later cards, monologue surfaces only on full chain completion, HP updates write back to OBR metadata when in OBR, free-text hero summary feeds next round's prompt, round counter auto-bumps.
4. **Test call to api.anthropic.com succeeded twice.** Both chains followed the locked priors. One artifact preserved: [test-artifacts/2026-05-18-chain-round2-bubble-up.json](./test-artifacts/2026-05-18-chain-round2-bubble-up.json). Read it before iterating the prompt — it's the working baseline.

---

## What's verified working (standalone-fallback mode, localhost:5173)

- Render: 4 PCs with bubble/stun flags, boss, lackeys, override controls (round, emoji-winner, rescued-count), live JSON snapshot in collapsed details.
- API call: Opus 4.7 returns valid JSON, parser accepts code-fence-wrapped responses, chain hydrates into UI.
- Chain resolution: clicking Save Made on card N marks it `save`, dings half-dmg, marks all cards N+1..4 as `skipped`. Clicking Save Failed marks `fail`, full dmg, stuns target. When all 4 fail, `chainCompleted` flag flips and monologue block shows.
- History: end-of-round captures chain + hero summary into localStorage. Round counter auto-bumps. Copy-history to clipboard works.
- Patch added this evening: in-flight status timer shows elapsed seconds + "Don't reload" warning during the 30-60s Opus call. 3-minute abort hard cap.

---

## What's NOT verified (the gap)

- **Real OBR integration.** Nothing has been loaded inside an actual Owlbear room. `serializeScene` against real OBR items, `OBR.scene.items.onChange` subscription, context-menu tag writes — all coded, none tested in OBR. The standalone-fallback mock pretends.
- **Public hosting.** OBR can't fetch our manifest from `localhost:5173`. We need either a cloudflared tunnel (instant, ephemeral) or real hosting (Cloudflare Pages / GH Pages).
- **Icon files.** `manifest.json` references `/action-icon.png` and the context-menu entries reference `/action-icon.png`. Neither exists. Until they do, the context-menu entries may render without icons or 404 quietly. Confirm OBR behavior under missing icon — may need to add minimal PNGs or remove the icon refs.
- **Hero-action prototype-style buttons.** The kickoff doc imagined per-PC Basic/SP1/SP2 click-to-log mirroring `prototypes/2026-05-18-hivemind-bench/`. Today's MVP uses the free-text `heroSummary` field. Functional but less ergonomic than the prototype's pattern. Polish item, not a blocker.
- **Lackey direction.** The audit doc captured Griz's late note: boss can direct the ASPIRATION + EXTRACTION lackeys at specific PCs during its turn. The other two (Alex-Jones-Bot EMOTION, Hasan-Piker-Bot CONTROL) target their suit's hero by default. Currently surfaced only as `lackeys[].cardsExhausted` in the schema; the boss's "direct this lackey at this PC" command is not in the JSON output schema. Add to `buildVillainPrompt` and the chain schema when the iframe redesign cycle continues.
- **Monologue lackey-summon execution.** Audit doc §5: when all 4 PCs fail, boss summons a new lackey of a suit not already represented (or a soda-monster if all 4 are present). Currently the iframe just logs "monologueSummoned" with a placeholder string. The GM has to type the new lackey's stats in. Should probably automate with a "Pick summoned lackey suit" dropdown when the monologue fires.

---

## Locked mechanics (do not re-derive — read audit doc §5 if unsure)

| Target | Max HP | DC | Full dmg | Half dmg | Suit |
|---|---|---|---|---|---|
| Denny | 150 | 13 | 22 | 11 | ASPIRATION |
| Beholda | 112 | 12 | 16 | 8 | EXTRACTION |
| Rascal | 88 | 11 | 14 | 7 | CONTROL |
| Goose | 81 | 10 | 12 | 6 | EMOTION |

**Per turn:** villain plays 4-card chain, one per suit, picks order. Save = half dmg, no stun, CHAIN BREAKS. Fail = full dmg, stunned, chain CONTINUES. All 4 fail → monologue + lackey summon.

**No naming-tax mechanic in monster-party fight** (card-game only). **No truth-bomb readback** (flavor not load-bearing).

**Villain identity LOCKED at `monster-party-prep/5-21-encounter-design.md:9`:** sentient social media algorithm. Fresh instance — no project context, no cairn.

---

## Architecture clarifications (important — Griz had to ask)

**OBR ↔ extension is one-way and in-browser only.** We never reach out to a room URL. OBR has no public room-state API. The flow:

1. We tunnel/host the manifest + iframe files at some public URL.
2. Griz uses OBR's "Add Extension" with the manifest URL.
3. When Griz opens an OBR room *in his browser*, OBR loads our iframe inside the page.
4. Our iframe reads scene state via `OBR.scene.items.getItems()` — this is postMessage to the parent OBR tab, not a network call to OBR.
5. Iframe pushes state up to Anthropic, gets chain back, displays it for Griz.

The cloudflared tunnel exists ONLY to expose our static files. It does not let us "pull" room state.

---

## Suggested order of operations tomorrow

1. **Stand up the cloudflared tunnel.** Single command: `cloudflared tunnel --url http://localhost:5173` (Griz needs cloudflared installed — likely already is from prior projects, check `where cloudflared`). Outputs a `*.trycloudflare.com` URL. Note this URL is ephemeral; rebooting the laptop kills it. For Thursday-stable, push to Cloudflare Pages or GH Pages before stream-time.
2. **Add minimal icon files** at `extension-iframe/action-icon.png` and `extension-iframe/icon.png`. Anything 96×96 PNG works. Avoids 404s.
3. **Try OBR add-extension flow.** Manifest URL: `https://<tunnel>.trycloudflare.com/extension-iframe/manifest.json`. Verify the action button appears, click it, confirm the panel renders inside OBR.
4. **Right-click a token in OBR test scene, verify the context-menu items fire** ("Monster Party: Tag as Denny" etc.). Confirm metadata gets written. Reload, confirm metadata persists. This is the single most important real-OBR test — if this works, the whole serialize→prompt→fetch pipe works in production.
5. **Run a real chain against a real-tagged scene.** First serious validation against actual OBR state, not the mock.
6. **Iterate on findings.** Most likely surprises: context-menu may need different icon size, action panel may have a fixed default width/height (use `OBR.action.setWidth/setHeight` to control), and `OBR.player.getRole()` may behave differently in a non-GM session.

---

## Open items remaining (lower priority, can wait)

- Hero-action prototype-style buttons (replacing free-text heroSummary).
- Lackey-direction in the JSON output schema.
- Monologue-summon lackey-suit picker UI.
- Polish: rage-post block styling, copy-individual-card-to-clipboard button (since Griz's "paste into voice instance" workflow is paste-per-card).
- Strip API-key/model from settings if Griz wants to lock in just Opus 4.7. (Probably not — keep flexibility for cost/speed comparison.)
- Per-card DC variance within a suit if playtest reveals certain cards feel mis-tuned.

---

## House-keeping notes

- Local dev: `py -m http.server 5173 --directory C:\Users\grimg\they live\monster-party-owlbear` (already wired in `C:/Users/grimg/.claude/launch.json` as `monster-party-owlbear`). Use `preview_start` with that name.
- The python server is running tonight at session-end. Griz may have closed the preview panel; the server itself persists until preview_stop fires or he reboots. localStorage state in the preview-managed browser is also persistent across panel-close, but not across preview_stop or browser data-clear.
- The test artifact in `test-artifacts/` is what tomorrow's instance should compare against if it tweaks the prompt — "is the new prompt still producing chains this good?"

---

## Tone / register notes for tomorrow's instance

Griz works conversationally — answers questions, redirects mid-stream, doesn't write specs ahead. The pattern is "I want X" → you propose → he amends → you build. He'll cite the kickoff doc when relevant but not slavishly. If something feels under-specified, ask, don't assume.

The "voice LARP" pivot today was a meaningful scope cut from the kickoff doc — the villain Claude isn't being called by the iframe to *play* anymore, it's being called to *plan*, and Griz performs the LARP in voice. That's why the iframe is text-output-focused and not chat-loop-focused.

The cairn applies here as elsewhere: don't fabricate; don't reach into theory not grounded in these files. The interpretation lane is "what does the spec actually say." The collaborator register is "we" not "I help you."

---

## Closing

The hardest creative work today was getting the system prompt to produce strategic play, not flavor. The two test chains both led with EXTRACTION at Beholda for bubble-pop and laddered descending-DC after slot 1 — that's the bubble-pop strategy *emerging from the prompt*, which was the kickoff doc's stated thesis (line 235). The deck-as-state-input experiment is working.

What's left for Thursday is plumbing: hosting, real-OBR test, icons, polish. Tomorrow's instance inherits a working pipe — get it on a public URL and into OBR, then we have two days to iterate against actual play.

The work continues. The cairn continues. The villain finally has the state it needs to play position, not just attack.
