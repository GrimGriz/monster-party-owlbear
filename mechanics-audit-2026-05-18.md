# Mechanics & State-Surface Audit
## 2026-05-18 — pre-Thursday scope-lock

**Purpose.** Griz called the question: with the build pivoted to *villain-Claude-LARPs-in-voice-chat* (no in-iframe Anthropic fetch), what does the iframe actually need to surface? This doc inventories (a) the per-card fields that matter for the **monster party fight** (not the Put-on-the-Glasses card game), (b) what OBR scene metadata gives us vs. what the villain needs in addition, and (c) the 24-card-by-target reference.

---

## 1. Per-card schema for the monster-party fight

What we drop from the card-game spec:
- **Naming Tax.** Card-game-only per Griz. Villain LARPing in voice doesn't need a magic-word/DC-drop interplay — that mechanic was about getting a separate AI villain to self-incriminate through prompt engineering. In the LARP, the villain just talks.
- **Truth bombs.** Still nice as flavor for the villain to know, but not mechanically load-bearing for the fight. The fight resolves on save/reply chain, not on truth-bomb readback.
- **`[TOPIC]` LARP slot.** The card game uses a topic draw; the boss fight has a topic (the Algorithm hates this stream), so the slot is fixed.

What we keep:
| Field | Source | Notes |
|---|---|---|
| `suit` | `villain-deck-source.js` | CONTROL / EMOTION / ASPIRATION / EXTRACTION / META / NONE |
| `name` | source | RAGE, FEAR, OBEY, etc. |
| `archetype` | source | one-line tag |
| `mechanic` | source | one-paragraph manipulation description |
| `targetHero` | **derived from suit** | locked binding (table below) |
| `targetSave` | **derived from suit** | Survival / Social / Wisdom / Heart |
| `baseDC` | **derived from suit** | per sample-cards.md pattern (table below) |
| `replyHooks` | sample-cards.md (6/24 known) | 3-5 card names; the villain's chain options on save-fail |

**Suit binding** (from battle-info.md §7):

| Suit | Color | Save | Target hero |
|---|---|---|---|
| CONTROL | red | Social | **Rascal** |
| EMOTION | orange | Heart | **Goose** |
| ASPIRATION | gold | Survival | **Denny** |
| EXTRACTION | purple | Wisdom | **Beholda** |
| META | indigo | (party-only Saving Throw) | — |
| NONE | — | UNCLASSIFIED card | — |

**Base DC by suit** (inferred from sample-cards.md — only 6 cards spec'd, but the pattern is consistent):

| Suit | Base DC | Why |
|---|---|---|
| CONTROL | 10 | "suit +0" |
| EXTRACTION | 10 | "suit +0 — but extends chains" |
| EMOTION | 11 | "suit +1" |
| ASPIRATION | 12 | "suit +2 — the subtlest" |

This is the proposal. If Griz wants per-card variance (e.g., FEAR DC ≠ RAGE DC within EMOTION), we'd need to expand sample-cards.md or just type it in here. **Default for Thursday: DC-by-suit, no per-card variance.**

---

## 2. Reply-hook coverage

Documented in sample-cards.md (Put-on-the-Glasses repo): 6 of 24.

| Card | Suit | Reply hooks (known) |
|---|---|---|
| RAGE | EMOTION | CONFORM, TRIBE, SILENCE, DISGUST, DOOM |
| CONFORM | CONTROL | VIRTUE, TRIBE, SILENCE, AUTHORITY |
| FOMO | ASPIRATION | GLOW, FLEX, HOPIUM, OPTIMIZE |
| HOPIUM | ASPIRATION | OPTIMIZE, GLOW, VIRTUE, SLEEP |
| NUMB | EXTRACTION | COPE, SLEEP, PARASOCIAL, CONSUME |
| SAVING THROW | META | (party invocation, not villain reply) |

**The other 18 cards have no documented reply hooks.** Options:
1. **Improvise live.** Villain picks any in-suit (double-damage) or any other-suit (cross-stun) card on the fly — GM ratifies. Lightest scope; most LARP-flexible.
2. **Pre-author all 24.** Probably a 30-min pass through sample-cards.md format. Tighter mechanics, more predictable narrative.
3. **Skeleton reply rule.** For each card: default reply pool = "any 2 same-suit cards + 2 cross-suit cards GM picks at runtime." Mechanical fairness without per-card authorship.

Recommend **option 1 for Thursday**: villain chooses any in-suit or any cross-suit card; the GM (you) sanity-checks the chain. The 6 documented reply hooks act as exemplars in the villain's context — "these are what good reply chains look like."

---

## 3. State surface: what OBR gives us vs. what villain needs

### A. What `serializeScene` returns from OBR token metadata (already implemented):

```
{
  round: int,
  party: [{ name, hp, maxHp, ac, bubbled, stunned, actionDiceAvailable, specialsRemaining, crystalsHeld }],
  boss: { hp, ac, cardsExhausted, tauntedTo },
  lackeys: [{ id, suit, archetype, hp, alive, cardsExhausted }],
  bonusDieWinner: 'Denny'|'Beholda'|'Rascal'|'Goose'|null,
  rescuedMemberEmojiCount: int
}
```

This is the **per-turn snapshot.** It changes when GM tags a token, edits HP via the panel, toggles bubbled/stunned, types in the round number / emoji winner.

### B. What's NOT in OBR (the iframe needs to hold or accept):

1. **The deck reference (24 cards-by-target).** Static. Bundle it in the iframe at load.
2. **The mechanic rules.** Static. Bundle as constants or a short rules block.
3. **History of prior turns.** Round 1 cards played, who saved, what stunned. Currently nowhere — needs a `history: []` log the GM appends to after each card resolves. Stays in `localStorage` so a refresh doesn't blow it away. Survives the fight, not the session.
4. **Villain identity.** "Sentient social media algorithm" — locked in encounter-design.md line 9. Bundle as a constant.
5. **Strategic priors.** Bubble-pop strategy (chain EXTRACTION at Beholda), Denny-taunt-respect, Rascal-fireball-feeds-cards. The villain LARPing needs these in their context window or you do — depends on whether you brief them or the iframe spits a briefing.

### C. The villain's per-turn context (everything they need to decide one card):

| Item | Source | Carries over? |
|---|---|---|
| Current BattleState snapshot | OBR + serializer | No (re-read each turn) |
| Cards exhausted so far | `boss.cardsExhausted` from snapshot | Yes (metadata persists) |
| What happened last round | history log (new) | Yes (localStorage) |
| Full deck w/ DC + target + reply hooks | bundled constant | n/a |
| Villain identity + strategic priors | bundled constant | n/a |
| Rule reminders (suit→save, reply rule, stun) | bundled constant | n/a |

**Implication for the iframe redesign:** the "Let Villain Choose Card" button doesn't fetch; it composes a **briefing block** combining (a) snapshot, (b) history, (c) reference deck filtered to non-exhausted cards. That block is what gets read aloud or pasted into the villain's conversation. The villain replies with a card name + rage-post + (optionally) pre-decided reply card. You type the resolution back into the panel (HP changes, append to history).

---

## 4. Cards-by-target reference (all 24, grouped by save → hero)

### ASPIRATION → Survival save → **Denny**  *(DC 12 baseline)*
- **GRIND** — Hustle Gospel
- **FLEX** — Status Display
- **FOMO** — Manufactured Urgency  *(replies: GLOW, FLEX, HOPIUM, OPTIMIZE)*
- **HOPIUM** — Magical Thinking Engine  *(replies: OPTIMIZE, GLOW, VIRTUE, SLEEP)*
- **OPTIMIZE** — Quantified Self Capture
- **GLOW** — Transformation Narrative

### CONTROL → Social save → **Rascal**  *(DC 10 baseline)*
- **OBEY** — Generic Authority Enforcement
- **TRIBE** — Binary Tribalism Engine
- **VIRTUE** — Moral Performance Display
- **AUTHORITY** — Expert Theater
- **CONFORM** — Manufactured Consensus  *(replies: VIRTUE, TRIBE, SILENCE, AUTHORITY)*
- **SILENCE** — Censorship Narrative Engine

### EXTRACTION → Wisdom save → **Beholda**  *(DC 10, chain-extender — primary bubble-pop suit)*
- **CONSUME** — Pure Attention Extraction
- **SLEEP** — Pacification Mantra
- **NUMB** — Cognitive White Noise  *(replies: COPE, SLEEP, PARASOCIAL, CONSUME)*
- **COPE** — Dysfunction Normalization
- **PARASOCIAL** — Intimacy Simulation
- **NOSTALGIA** — Temporal Identity Capture

### EMOTION → Heart save → **Goose**  *(DC 11 baseline)*
- **RAGE** — Outrage Bait Engine  *(replies: CONFORM, TRIBE, SILENCE, DISGUST, DOOM)*
- **FEAR** — Ambient Threat Loop
- **ENVY** — Comparison Engine
- **WEEP** — Sentimentality Weapon
- **DOOM** — Nihilism Engine
- **DISGUST** — Purity/Contamination Frame

### META / NONE  *(not villain-playable)*
- **SAVING THROW** (META, indigo) — the party invocation card. Used by PCs vs the chain, not by villain.
- **UNCLASSIFIED** (NONE) — non-attack signal. Not played as a card.

---

## 5. LOCKED (2026-05-18 evening)

### Per-target damage & DC
| Target | Max HP | DC | Full dmg (fail) | Half dmg (save) | Suit |
|---|---|---|---|---|---|
| **Denny** | 150 | 13 | 22 | 11 | ASPIRATION |
| **Beholda** | 112 | 12 | 16 | 8 | EXTRACTION |
| **Rascal** | 88 | 11 | 14 | 7 | CONTROL |
| **Goose** | 81 | 10 | 12 | 6 | EMOTION |

Damage = ~15% of max HP rounded so half-damage is a clean integer. DC scales 10→13 with HP. DC is roll-to-meet (lower = easier save = chain breaks faster = harder for villain). Numbers editable in playtest if too many total-party-wipes.

### Per-turn villain action: 4-card chain
- One card per suit. Each card targets its suit's hero — so the chain hits all 4 PCs in an order the villain picks.
- Each card resolves: **save = half dmg, no stun, chain BREAKS**. **Fail = full dmg, stunned, chain CONTINUES to next card.**
- Reply hooks (per sample-cards.md) inform which card from the next suit the villain picks — but with one-per-suit, the constraint is just "pick a card from each suit." Reply-hook narrative coherence is a LARP guideline, not a mechanical rule.

### Monologue (chain completes — all 4 PCs fail)
Boss delivers a monologue and **summons a new lackey**, fueled by the drained energy. Lackey suit = a suit not currently represented on the field by a surviving lackey. If all 4 suits are already represented, fall back to a **soda lackey** (encounter-3 stat block, ~30 HP, AoE Crushed Ice). This is the chain-completion payoff.

### Lackey direction (boss-controlled targeting)
- EMOTION lackey (Alex-Jones-Bot, encounter 4) and CONTROL lackey (Hasan-Piker-Bot, encounter 5) play their single-suit deck against their suit's keyed PC as normal.
- The **ASPIRATION and EXTRACTION lackeys** (the two not "already named" in earlier encounters) can be **directed by the boss** to target a specific PC during the boss's turn. Mechanics TBD — for Thursday MVP, the iframe surfaces this as a free-text "lackey orders" field the GM types; later we can structure it.

### Save mechanics confirmation
Cards do **HP damage** (15% by target, table above). On save = half damage, no stun. On fail = full damage, stunned (lose one action per battle-info §3 — this round if before they've acted, next round if after).

### Naming Tax — REMOVED for monster-party fight
Card-game-only mechanic per Griz. The voice-LARP villain doesn't get a DC-drop for self-naming — the rage-post is performance, not parseable text.

---

## 6. Still open (lower priority, can drift until playtest)

1. **Per-card variance within a suit.** Currently DC = by-suit-flat per the table. If playtest shows e.g. RAGE feels too easy at DC 11 while FEAR feels right, we can add per-card overrides.
2. **History log shape.** Proposed: `{round, chain: [{suit, cardName, targetHero, result: 'save'|'fail', dmg}], chainBrokenAt: int|null, monologueSummoned: lackey|null, heroActions: [{pc, action, target, result}], notes}`. Persists to localStorage.
3. **Hero-action logging UX.** Prototype-style per-PC buttons (Basic / Special1 / Special2 / Heal / Taunt) is the model. The exact button set per PC needs spec — Denny has Taunt+Denim Damage, Beholda has VNA Bubble+Baleful Gaze, etc. Mirror battle-info §2.
4. **Briefing format.** Both read-aloud and paste-block, two tabs in the panel.

---

## 7. What the iframe ends up looking like (sketch)

If we land everything above, the panel becomes three vertical sections:

1. **Battle State** (current — the JSON block, but humanized: bullet list of PCs with bubble/stun/HP highlighted, boss HP bar, lackey roster, round + emoji-winner + rescued-emoji-count overrides as inputs).
2. **History log** — collapsible. Last 2-3 rounds always visible; full log available.
3. **Briefing for the Villain** — generated on demand or live. Two tabs: *Speak* (human-readable summary) and *Paste* (a compact text block with the snapshot + history + non-exhausted deck-by-target + rule reminders).

The "Let Villain Choose Card" button becomes "Generate Briefing." After the villain LARPs their card, you (a) type the resolution into a small form, (b) it appends to history and updates the relevant token metadata.

No Anthropic fetch in the v1 critical path. Keep the key field hidden behind a "Settings" disclosure if we want to leave the door open for post-Thursday automation.

---

## 8. Next step

Numbers + mechanics locked (§5). Building order:
1. `state-pipe/cards-by-target.js` — bundled deck w/ derived fields.
2. `state-pipe/prompt-builder.js` — real implementation. System prompt = villain identity + mechanics + deck + 4-card-chain JSON schema.
3. `app.js` — Anthropic fetch, render chain, Save/Fail buttons per card, history → localStorage.
4. Hero-action panel (mirrors prototype) — next cycle.
5. Hosting (cloudflared tunnel for testing, real host before Thursday) — next cycle.
