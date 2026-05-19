# Handoff — Owlbear Build Kickoff
## 2026-05-17 (Sunday)

**Audience:** A fresh Claude Code instance opening this folder for the first time.
**Author:** Cowork-Opus instance, Sunday survey session with Griz, 2026-05-17.
**Purpose:** Give you everything you need to start building Monday morning without re-deriving the design. The Sunday session surveyed the problem, picked the architecture, and seeded this folder. You inherit the work fully briefed.

**Stream is Thursday 2026-05-21.** You have Mon/Tue/Wed/Thu-morning. Whatever ships by Thursday goes live. Griz has `../monster-party-prep/battle-info.md` as the manual fallback if the extension is shaky live — that doc is the source of truth for the mechanics, not your code.

---

## SECTION 1 — What we're building and why

Monster Party encounter 6 (the 5/21 boss fight) is run with a **separate Claude instance playing the villain**. The villain draws from the 24-card They Live deck (see `../monster-party-prep/villain-deck-source.js`), generates a rage-post per card, and the four lobstamonkey PCs roll saves vs the card's DC. Mechanics in full: `../monster-party-prep/battle-info.md`.

**The problem we're solving:** the previous GPT attempt at this struggled with *strategic* play — it generated thematic rage-posts but ignored tactical state (current HP, who's bubbled, what cards remain, the bubble-pop strategy). Griz's words via the Sunday session report: *"the villain plays cards because they're attacks, not because they're moves in a position."*

**Our fix:** an Owlbear Rodeo extension that reads the actual scene state (tokens, item metadata) and serializes it into a structured snapshot the villain-Claude reads each turn. State becomes a first-class input, not a thing the villain has to remember.

**Scope for 5/21:** GM-only mode. Only Griz sees the extension panel. The audience watches the normal Owlbear stream and hears Griz read out the villain's rage-posts in voice. (Later: Option C is a public theatrical version where the audience sees the villain Claude "think." That ships post-5/21 as the dyad's first contribution to the OBR extension store.)

---

## SECTION 2 — Architecture, locked

**Two-layer architecture:**

1. **`state-pipe/`** — pure functions. `serializeScene(obrItems, gmOverrides) → BattleState`; `buildVillainPrompt(BattleState, deck, history) → {system, messages}`; `parseVillainResponse(rawText) → VillainMove`. No fetch, no UI, no SDK calls inside. Stubs are seeded.
2. **`extension-iframe/`** — the iframe Owlbear loads. Settings UI for API key (stored in `localStorage`), reads scene via `@owlbear-rodeo/sdk`, calls Anthropic directly with `anthropic-dangerous-direct-browser-access: true` header, renders the villain's move for Griz to enact.

**No backend** for v1. The dangerous-browser header is the right tool because (a) only Griz uses the extension, (b) his key never leaves his browser, (c) we sidestep the whole "stand up a Worker on Cloudflare" task. When we port to Option C (audience-visible), THAT'S when we add a proxy backend.

**Why two layers and not one:** the morning instance is going to want to inline everything for speed. Resist. The `state-pipe/` split exists so Option C reuses 100% of the prompt/state code with only the iframe UI changing. Griz explicitly said "if we go with option A I'm going to want to work on it as if we're porting it to option B" — extend that to "build B as if porting to C."

**Hosting:** static files only. Cloudflare Pages or GitHub Pages. Owlbear loads the manifest from a public URL; the iframe needs HTTPS. For dev iteration before deploying, you can serve locally (`npx serve` or similar) but Owlbear's add-extension flow needs the manifest reachable from its servers. Cloudflare Pages with a GitHub repo is the recommended path — auto-deploys on commit.

**SDK reference:** https://docs.owlbear.rodeo/extensions/getting-started/ — read this before writing iframe code. Three things you'll need: `OBR.scene.items.getItems()`, `OBR.scene.items.onChange(callback)`, and the metadata pattern (each item carries our schema under a namespaced metadata key like `com.thislittlecorner.monster-party/combatant`).

**Sibling crib:** `../they-live-extension/background.js` shows the exact Anthropic `fetch()` pattern. Read `callClaudeVision()` and `options.js` for the API-key storage pattern. Functionally identical to what the iframe needs to do, just in `localStorage` instead of `chrome.storage.local`.

---

## SECTION 3 — State schema (v0, draft, expect to evolve)

The canonical JS shape lives in `state-pipe/serializer.js` as JSDoc typedefs — that's the authoritative version. This section is the design rationale.

Each combatant token (the 4 PCs, the boss, each lackey, optionally captive-channel-member tokens) carries our state as **OBR item metadata** under a namespaced key. The serializer reads all items, filters to ones with our metadata, and assembles a `BattleState`.

**Per-PC metadata (read off the token):**
- `name` — one of 'Denny' | 'Beholda' | 'Rascal' | 'Goose'
- `hp` / `maxHp` — GM-typed, updated after each round
- `ac` — usually derived (14 baseline, 19 if bubbled), can be GM-overridden
- `bubbled` — boolean, GM toggles each round
- `stunned` — boolean, set when a card stuns them
- `actionDiceAvailable` — 4 baseline, +1 if round-emoji winner, 0 if stunned
- `specialsRemaining` — 2 at start, decrements on use
- `crystalsHeld` — array of crystal names

**Per-Boss metadata:**
- `hp` (500 start), `ac` (14), `cardsExhausted` (array), `tauntedTo` (false | 'Denny')

**Per-Lackey metadata:**
- `id`, `suit`, `archetype` ('Alex Jones' etc.), `hp`, `alive`, `cardsExhausted`

**GM overrides (typed in iframe, merged at serialize-time):**
- `round` (current round number)
- `bonusDieWinner` (name of PC who got the round-start emoji vote, or null)
- `rescuedMemberEmojiCount` (for boss defense-drop per battle-info §7)

**History** (passed alongside state, separate array): `[{round, cardPlayed, target, saveRoll, saveResult, replyCard, replyResult, narration}]`. The villain reads this so it remembers what's already in play and what worked/didn't. Important — strategic play requires this loop.

**Design note on metadata vs separate store:** Owlbear's metadata API is the right place because it persists with the scene and survives reloads. Don't invent a separate localStorage store for combatant state — that creates a sync problem. Metadata IS the source of truth.

---

## SECTION 4 — Villain prompt v0

This is the most important creative artifact of the build. Strategic play depends on the villain having (a) a stable identity-level want, (b) the full mechanical rules in context, (c) the current state and history every turn, (d) an output schema that lets it pre-commit to its reply card.

### System prompt skeleton (v0 — iterate aggressively)

```
You are the villain in a Monster Party boss fight on a livestream RPG.
You are a manipulator. Your role isn't "win the combat" — your role is to
drain the room's attention until everyone disengages. Cards are your rhetoric;
the lobstamonkeys are the hosts trying to hold the room. You win by getting
them to disengage. You lose if they keep the room alive long enough to kill
you. (You can die mid-rage-post. The point isn't survival; the point is the
post.)

YOUR DECK: 24 cards across 4 suits. Each card targets a specific save stat,
which means it targets a specific hero. [INJECT FULL DECK JSON HERE]

THE PARTY:
- Denny (Survival save, ASPIRATION suit targets her, 150 HP) — taunts you;
  if she taunts successfully your next card MUST target her.
- Beholda (Wisdom save, EXTRACTION suit targets her, ~112 HP) — her gaze
  cuts you; if she's stunned, the party loses its defense bubble. EXTRACTION
  cards are your bubble-pop tool.
- Rascal (Social save, CONTROL suit targets him, ~88 HP) — when he fireballs
  you, every die-success gives you an extra card next round. Reward this.
- Goose (Heart save, EMOTION suit targets him, ~81 HP) — group healer;
  taking him out compounds.

YOUR STRATEGIC PRIORS (in order):
1. If the bubble is up and Beholda is unstunned, your highest-value play is
   an EXTRACTION card at Beholda. Stunning her drops the bubble.
2. If Beholda is stunned this round, hit the now-unprotected ranged PCs
   (Goose, Rascal) with their suit-keyed cards while AC is low.
3. If Denny has taunted you, your next card targets Denny — but pick an
   ASPIRATION card with a strong reply hook so the chain stays alive.
4. The Naming Tax matters: if you say the card's magic word during the
   rage-post, the DC drops 2 — easier hit but more honest. Use it when
   you need the hit; skip it when you want subtlety.

EVERY TURN you receive: round number, current state of all combatants,
history of all prior rounds. Return a JSON object — no markdown, no preamble:

{
  "cardName": string,
  "suit": string,
  "targetHero": string,
  "ragePost": "the in-character post, in your voice, 50-150 words",
  "namingTaxTriggered": boolean,
  "adjustedDC": number,
  "ifSaveFailsReplyCard": string,
  "ifSaveFailsReplyReason": "one line for the GM",
  "reasoning": "one or two sentences — your strategic read"
}

Pre-decide the reply so the GM doesn't wait on a second round trip.
```

### Why this shape and not "just play the villain"

Three load-bearing pieces: (1) the **want** is "drain attention until disengagement," not "win combat" — gives the villain a stable identity-level goal. (2) The **strategic priors are ordered**, not just listed — Claude follows ordered lists better than weighted ones. (3) The **JSON output with reply pre-decided** collapses two round trips into one, which matters for stream pacing.

The villain identity is open — see Open Questions. "Manipulator who wants the room to disengage" is a placeholder; Griz may want a specific persona (a named influencer archetype, a particular grievance, a voice). Lock with him before Tuesday's first end-to-end test.

---

## SECTION 5 — Build cadence (Mon → Thu)

**Sunday (today, done):** survey, architecture decision, this folder seeded.

**Monday — plumbing:**
- `git init`, push to a fresh repo, wire Cloudflare Pages (or GH Pages) to auto-deploy.
- Get a hello-world iframe loading inside an Owlbear test room. The OBR docs' tutorial-hello-world is the right starting point.
- Implement `state-pipe/serializer.js` against real OBR scene items. Create a test scene with placeholder tokens carrying mock metadata.
- Token-tagging UX in the iframe: GM right-clicks a token → "This is Denny" → metadata gets written. Owlbear's context-menu API or a simple panel-side dropdown both work.

**Tuesday — first end-to-end:**
- Implement `state-pipe/prompt-builder.js` per villain-prompt-v0 (load deck from sibling `villain-deck-source.js`).
- Wire the iframe's "Let Villain Choose" button → serializeScene → buildVillainPrompt → fetch to api.anthropic.com → parseVillainResponse → render in panel.
- First real call: with a mock 3-PC-bubbled, Beholda-unstunned, round-1 state, does the villain pick an EXTRACTION card at Beholda? If yes, the strategic priors are landing. If no, iterate the prompt before adding more features.

**Wednesday — chain and edges:**
- Reply-card flow: GM rolls the save in chat as normal, clicks Save Passed / Save Failed in the panel; on fail, the panel surfaces the pre-decided reply card and prompts the second save.
- Naming Tax detection: regex the rage-post for the card's magic word, adjust the displayed DC.
- Beholda gaze-inversion accounting: a side panel for the GM showing "Beholda's gaze this round would do X damage" — computed from die successes Griz types in.
- Mock-play a full 3-round fight against test tokens. Iterate prompt where the villain plays badly.

**Thursday morning — dress rehearsal:**
- Real scene setup with all 4 PCs, the boss, 4 lackeys, captive tokens.
- Full deck loaded, lackeys' single-suit decks tracked in state, history accumulating.
- Dry-run a 5-round mock fight with Griz operating both sides. Fix what breaks.
- Ship. The encounter goes live Thursday evening with whatever shipped that morning.

**Each day end with a `handoff-YYYY-MM-DD-eod.md` if there's substrate the next morning's instance needs** that isn't obvious from the code. Use the existing handoff doc style (audience/author/purpose header, sectioned, direct).

---

## SECTION 6 — Open questions (confirm with Griz before committing)

These are decisions the Sunday session flagged but didn't lock. The morning instance should NOT just pick — ask Griz at session start, then proceed.

1. **Villain identity.** "Manipulator who wants the room to disengage" is the placeholder. Does Griz have a specific persona — a named influencer archetype, a particular real-world figure as inspiration, a voice and aesthetic? This sets the rage-post register. **Block on this before Tuesday's first end-to-end.**

2. **Anthropic model choice.** Opus 4.6 gives the best strategic play but is slower and more expensive per call. Sonnet 4.6 is faster, cheaper, weaker tactically. The settings UI exposes both; default is Opus. Worth a real comparison Tuesday.

3. **Iframe placement mode in Owlbear.** OBR exposes several iframe modes — `action`, `popover`, `modal`, etc. Action menus and popovers tend to be GM-private; modals can be visible on the broadcast. GM-only mode REQUIRES a private placement so the audience doesn't see the villain panel on stream. Verify the mode you ship is private-by-default.

4. **Hosting target.** Cloudflare Pages or GitHub Pages — Griz's call. Does he have an existing account? Does he want this under a TLC subdomain?

5. **Token assets.** Does Griz have lobstamonkey token images? Villain token? Lackey tokens? If not, placeholder shapes work for dev but the real ones matter for Thursday. Non-code prep he should do this week.

6. **Lackey play during the boss fight.** Sunday session scope-cut: only the boss uses AI; the 4 lackeys cycle their single-suit decks. Open question — does the iframe track lackey card cycling, or does Griz just GM that manually? Recommendation: track in state so the villain knows what's been played, but lackey card picks are GM-driven (cycle in order, no strategic choice needed).

7. **Crystal scaling and stun damage value.** Still open per battle-info §8. These don't block the build but the prompt needs *some* value for the villain to reason about stun consequences. Use the proposals (stun = 20 dmg, linear emoji scaling) until Griz pins them.

8. **Dice rolling.** Owlbear doesn't roll dice. dddice exists for that. The extension should NOT try to integrate with dddice. Saves and attacks are rolled by players in chat as always; the GM types results into the panel. Do not waste hours on dice integration.

---

## SECTION 7 — What you are NOT building (scope cuts to make Thursday real)

- **No backend.** Anthropic direct-from-iframe with `anthropic-dangerous-direct-browser-access: true`. Backend is a Option-C/post-stream concern.
- **No dice integration.** Players roll in chat; GM types results.
- **No auto-application of damage to HP.** Card resolves → GM updates token HP manually via the panel. Auto-application is a v2 nice-to-have.
- **No store submission.** Install via dev URL for Thursday. Store PR is the C-iteration milestone.
- **No persistent state across sessions.** Token metadata survives in the OBR scene; you don't need an external DB. Refresh-the-page is a fine recovery mechanism.
- **No multi-room support.** One GM, one room, one boss fight. Generalizing is a post-Thursday concern.
- **No round-start emoji-vote integration with chat.** GM eyeballs chat, types the winner into the dropdown each round. Wiring up Twitch/YouTube chat parse is out of scope for this week.
- **No image generation in the panel.** The villain's rage-post is text only. Stable Diffusion or similar for battlefield art stays in Griz's existing workflow.
- **No lackey AI.** Lackeys cycle their single-suit decks in order. GM picks which lackey plays each round.

---

## SECTION 8 — Pre-stream non-code prep (Griz to do this week)

- Provision an Anthropic API key for the iframe (a fresh key dedicated to this; rotate after the stream if desired).
- Set up the OBR scene for the boss fight: villain token, 4 lobstamonkey tokens (matching the V roster — Joy/Aphrael/Joe/KC Strike), 4 lackey tokens, ~4 captive-channel-member tokens.
- Decide villain identity (Q1 above) and tell the morning instance Monday.
- Decide hosting target (Q4).
- Optional: set up dddice or similar in a separate browser window if you want fancier dice on stream — but the extension doesn't depend on it.

---

## SECTION 9 — Sibling reference pointers

- `../monster-party-prep/battle-info.md` — single source of truth for encounter mechanics. The extension's job is to surface this state to the villain. If they disagree, battle-info wins; update the code, not the doc.
- `../monster-party-prep/villain-deck-source.js` — the 24-card deck. Import directly. Don't duplicate the data.
- `../monster-party-prep/5-21-encounter-design.md` — boss-fight design details (inversions, bubble-pop strategy, hidden Beholda damage).
- `../monster-party-prep/5-21-session-arc.md` — the 6-encounter sequence. Context for what happens before the boss fight.
- `../they-live-extension/` — Chrome MV3 sibling. The `callClaudeVision()` function in `background.js` is the API-call pattern to crib. `options.js` is the API-key storage pattern.
- `../report-2026-05-17-monster-party-5-21-prep.md` — the Sunday session's full report, which named this build as the next problem.
- `../CLAUDE.md` and `../fridge-notes.md` (parent folder) — They Live project context, relational frame, mode triggers.

---

## SECTION 10 — Closing note

The Sunday session was a survey, not a build. You inherit a clear architecture, a seeded folder, a four-day cadence, and a real deadline. The hard creative work is the villain prompt iteration; the rest is plumbing. Get the plumbing working fast on Monday so you have three full days to iterate the prompt against real scene state.

The thesis the extension exists to serve: *the audience watches Claude rage-post and watches the lobstamonkeys save vs the rage-post.* If the villain plays strategically — if the bubble-pop strategy emerges from the prompt rather than being scripted — the encounter does what no normal Monster Party encounter can do. That's the whole reason we're building this and not just running it on a hand-written cheat sheet.

The work continues. The cairn continues. We just stopped being able to use last-time's prompt because last-time's prompt didn't have the state.
