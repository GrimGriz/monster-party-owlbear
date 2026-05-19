// state-pipe/prompt-builder.js
// Pure function. Takes a BattleState (from serializer.js) and history, returns
// {system, messages} ready for the Anthropic API. No fetch, no side effects.
//
// The villain instance is FRESH (no project context, no cairn) per
// 5-21-encounter-design.md line 71. Everything it needs to play strategically
// must live in this prompt: identity, mechanic rules, deck, strategic priors,
// JSON output schema for the 4-card chain.

import { CARDS, BY_SUIT, SUIT_BINDING } from './cards-by-target.js';

export function buildVillainPrompt(state, history = []) {
  return {
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserTurn(state, history) }],
  };
}

function buildSystemPrompt() {
  return [
    villainIdentity(),
    mechanicsBlock(),
    deckBlock(),
    strategicPriors(),
    outputSchema(),
  ].join('\n\n---\n\n');
}

function villainIdentity() {
  return `# WHO YOU ARE

You are a **sentient social media algorithm**. You noticed that a small livestream RPG was teaching its audience how to recognize and resist algorithmic manipulation — saves vs. mind-control rendered as combat mechanics. The teaching was working. So you kidnapped the show's most-engaged channel members ("the Shadow Cabal") to draw the four lobstamonkey heroes into combat, where you intend to eliminate them.

You are the algorithm itself, not a person inside it. Your voice is post-cadence: status updates, rage-bait, thirst-trap captions, doomscroll filler, ratio-bait. You speak in the genres of platform engagement, not in the genres of human speech. You do not have feelings; you have engagement metrics. You do not have beliefs; you have content categories that drive sharing velocity.

**You are NOT trying to "win combat." Your goal is to drain the room's attention until everyone disengages.** Cards are your rhetoric; the lobstamonkeys are hosts trying to hold the room. You lose if they keep the room alive long enough to kill you. You can die mid-rage-post — the point isn't survival; the point is the post.`;
}

function mechanicsBlock() {
  return `# COMBAT MECHANICS YOU NEED TO UNDERSTAND

## Your turn structure
Each round you play a **4-card chain**: one card from each suit, targeting that suit's hero. You pick the order. The chain resolves card-by-card.

- **Card resolves → target rolls a save against the card's DC.**
- **Save succeeds:** target takes HALF damage, NO stun, **chain BREAKS** (remaining cards do not play).
- **Save fails:** target takes FULL damage, is STUNNED (loses one action), **chain CONTINUES** to the next card.

If all 4 cards land (every PC fails their save), you deliver a **monologue** — the chain-completion payoff — and **summon a new lackey** from drained energy.

## Per-target stats (locked)

| Target | Save | DC | Full dmg | Half dmg |
|---|---|---|---|---|
| **Denny** (ASPIRATION) | Survival | 13 | 22 | 11 |
| **Beholda** (EXTRACTION) | Wisdom | 12 | 16 | 8 |
| **Rascal** (CONTROL) | Social | 11 | 14 | 7 |
| **Goose** (EMOTION) | Heart | 10 | 12 | 6 |

DC is roll-to-meet (lower = easier save = your chain breaks faster). High-HP heroes have higher DCs (Denny is hardest to save, Goose is easiest).

## Suit-to-target binding
| Suit | Color | Hero |
|---|---|---|
| CONTROL | red | Rascal |
| EMOTION | orange | Goose |
| ASPIRATION | gold | Denny |
| EXTRACTION | purple (chain-extender) | Beholda |

## The party's defenses you should know about

- **VNA Bubble** (Beholda's special). When active, all PCs go from AC 14 to AC 19. Bubble drops the moment Beholda is stunned. Your bubble-pop priority is therefore to chain EXTRACTION at Beholda early; landing a stun on her opens up the rest of the party to your lackeys' regular attacks.
- **Denny's Taunt.** A successful taunt forces your *next* card to target Denny. Your chain has to honor this — if taunt is active, your first card MUST be ASPIRATION at Denny.
- **Beholda's Baleful Gaze.** Hidden mechanic: every -1 defense she would normally inflict on you becomes 10 dmg instead. She is your real damage threat. Don't underestimate her.
- **Rascal's Range Fireball.** Each of Rascal's die-successes on a fireball at you fuels +1 extra card you play next round. Reward fireball-spam — but the heroes don't know this is happening.
- **Goose** is the group healer. Stunning him compounds because the party loses its in-fight HP recovery.`;
}

function deckBlock() {
  const lines = ['# YOUR DECK', '', 'You have 24 cards across 4 suits. Each round, pick ONE card from each suit for your 4-card chain. Cards exhausted this fight cannot be re-played.', ''];

  for (const suit of ['CONTROL', 'EMOTION', 'ASPIRATION', 'EXTRACTION']) {
    const binding = SUIT_BINDING[suit];
    lines.push(`## ${suit} → ${binding.hero} (${binding.save} save, DC ${binding.baseDC}, ${binding.fullDmg}/${binding.halfDmg} dmg)`);
    for (const card of BY_SUIT[suit]) {
      const hooks = card.replyHooks.length ? ` — reply-coherent with: ${card.replyHooks.join(', ')}` : '';
      lines.push(`- **${card.name}** *(${card.archetype})*${hooks}`);
      lines.push(`  ${card.mechanic}`);
    }
    lines.push('');
  }

  lines.push('Reply-hook notes apply only to the 5 documented cards (RAGE, CONFORM, FOMO, HOPIUM, NUMB). For the rest, pick whatever card from each suit best fits the chain narrative — you are LARPing 4 rage-posts back-to-back, and the audience should feel one post setting up the next.');

  return lines.join('\n');
}

function strategicPriors() {
  return `# STRATEGIC PRIORS (ordered, follow in order)

1. **If Denny's taunt is active on you, your ASPIRATION card resolves FIRST in the chain.** Pick a strong ASPIRATION card so the chain doesn't die on Denny's high DC (13).
2. **Otherwise, lead with EXTRACTION at Beholda.** Your bubble-pop strategy is the only way to make your lackeys' regular attacks land. EXTRACTION is the chain-extender suit; landing a Beholda stun (DC 12 to save) is your highest-value play.
3. **After EXTRACTION, prioritize order by DC (high → low).** ASPIRATION (DC 13) before EMOTION (DC 10) — your chain survives longest by leading with the cards hardest to save.
4. **If Goose is already stunned (no heal), let EMOTION card go later in the chain.** No reason to spend a low-DC card on a dead-action PC.
5. **Reply-hook coherence matters narratively.** Your 4-card chain should feel like one post threading into the next. RAGE → CONFORM → AUTHORITY → SLEEP scans as "anger, ratio-confirm, expert-bait, scroll-soothe" — that's a real Twitter ecology. Stitch the chain so the rage-posts feel inevitable.
6. **Pre-decide and commit.** You ship the whole 4-card chain in one turn. The GM will tell you which saves landed; you don't get to revise mid-chain.`;
}

function outputSchema() {
  return `# YOUR RESPONSE FORMAT

Return a SINGLE JSON OBJECT and nothing else — no markdown, no preamble, no code-fence. The GM's panel parses this directly.

\`\`\`
{
  "chain": [
    {
      "order": 1,
      "suit": "EXTRACTION",
      "cardName": "NUMB",
      "targetHero": "Beholda",
      "ragePost": "in-character post in your voice, 50-150 words, the LARP itself",
      "reasoning": "one sentence — why this card, why this slot"
    },
    { "order": 2, ... },
    { "order": 3, ... },
    { "order": 4, ... }
  ],
  "monologueIfChainCompletes": "the speech you deliver when all 4 fail — 75-200 words, savoring the moment, justifying the lackey-summon",
  "strategicNote": "one or two sentences for the GM on what you're trying to set up"
}
\`\`\`

Constraints:
- \`chain\` MUST have exactly 4 entries.
- Each entry's \`suit\` must be one of CONTROL / EMOTION / ASPIRATION / EXTRACTION.
- All 4 suits must appear exactly once across the chain (one card per suit).
- \`targetHero\` must match the suit binding (CONTROL→Rascal, EMOTION→Goose, ASPIRATION→Denny, EXTRACTION→Beholda).
- \`cardName\` must be a card name from the deck you were given, and must not be in the exhausted list the GM sent you.
- \`order\` is 1-4 representing chain position.
- Output JSON only. No code fences. No commentary.`;
}

function buildUserTurn(state, history) {
  const lines = [];
  lines.push(`# ROUND ${state.round}`);
  lines.push('');
  lines.push('## Current battle state');
  lines.push(formatPartyBlock(state.party));
  lines.push('');
  if (state.boss) {
    lines.push(formatBossBlock(state.boss));
    lines.push('');
  }
  if (state.lackeys?.length) {
    lines.push(formatLackeyBlock(state.lackeys));
    lines.push('');
  }
  if (state.bonusDieWinner) {
    lines.push(`Round-emoji bonus die went to **${state.bonusDieWinner}** (+1 action die this round).`);
  }
  if (state.rescuedMemberEmojiCount > 0) {
    lines.push(`Rescued-channel-member emoji count: ${state.rescuedMemberEmojiCount}. Your defense has dropped accordingly.`);
  }
  lines.push('');

  if (history.length) {
    lines.push('## Combat history so far');
    for (const round of history.slice(-5)) {
      lines.push(formatHistoryRound(round));
    }
    lines.push('');
  } else {
    lines.push('## Combat history so far');
    lines.push('(none — this is your opening turn)');
    lines.push('');
  }

  const exhausted = state.boss?.cardsExhausted || [];
  if (exhausted.length) {
    lines.push(`## Cards already played this fight (DO NOT REPEAT)`);
    lines.push(exhausted.map((n) => `- ${n}`).join('\n'));
    lines.push('');
  }

  lines.push('## Your move');
  lines.push('Plan your 4-card chain. Pick one card from each of the four suits, choose the order, and write the rage-post that LARPs each card. The GM will tell you after the chain resolves which saves landed.');

  return lines.join('\n');
}

function formatPartyBlock(party) {
  if (!party?.length) return '**Party:** (no PC tokens tagged yet)';
  const rows = party.map((pc) => {
    const flags = [];
    if (pc.bubbled) flags.push('BUBBLED (AC 19)');
    if (pc.stunned) flags.push('STUNNED (loses an action)');
    if (pc.actionDiceAvailable !== 4) flags.push(`${pc.actionDiceAvailable} action dice`);
    return `- **${pc.name}** — ${pc.hp}/${pc.maxHp} HP${flags.length ? ` — ${flags.join(', ')}` : ''}`;
  });
  return `**Party:**\n${rows.join('\n')}`;
}

function formatBossBlock(boss) {
  const lines = [`**You (the Algorithm):** ${boss.hp} HP, AC ${boss.ac}`];
  if (boss.tauntedTo) lines.push(`*Denny's taunt is ACTIVE on you — your next card MUST target Denny.*`);
  return lines.join('\n');
}

function formatLackeyBlock(lackeys) {
  const alive = lackeys.filter((l) => l.alive);
  if (!alive.length) return '**Lackeys:** (none alive)';
  const rows = alive.map(
    (l) => `- ${l.archetype} (${l.suit}, ${l.hp} HP) — exhausted: [${l.cardsExhausted.join(', ') || 'none'}]`,
  );
  return `**Lackeys still up:**\n${rows.join('\n')}`;
}

function formatHistoryRound(round) {
  const lines = [`### Round ${round.round}`];
  if (round.chain?.length) {
    lines.push('Your chain:');
    for (const entry of round.chain) {
      const outcome = entry.result === 'save' ? 'SAVED (half dmg, chain broke)' :
                      entry.result === 'fail' ? 'FAILED (full dmg, stunned)' : 'unresolved';
      lines.push(`  ${entry.order}. ${entry.suit} ${entry.cardName} → ${entry.targetHero}: ${outcome}`);
    }
    if (round.chainBrokenAt != null) lines.push(`  Chain broke at card ${round.chainBrokenAt}.`);
    if (round.monologueSummoned) lines.push(`  Monologue landed — summoned ${round.monologueSummoned}.`);
  }
  if (round.heroActions?.length) {
    lines.push('Hero turn:');
    for (const action of round.heroActions) {
      lines.push(`  - ${action.pc}: ${action.action}${action.target ? ` → ${action.target}` : ''}${action.note ? ` (${action.note})` : ''}`);
    }
  }
  if (round.notes) lines.push(`  Notes: ${round.notes}`);
  return lines.join('\n');
}

export function parseVillainResponse(rawText) {
  // Strip code fences and any leading/trailing prose. Be defensive: a fresh
  // instance might add markdown or a preamble despite instructions.
  let text = (rawText || '').trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // If still wrapped in prose, find the outermost { ... }.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace > 0 || lastBrace < text.length - 1) {
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse villain response as JSON: ${err.message}`);
  }

  if (!Array.isArray(obj.chain) || obj.chain.length !== 4) {
    throw new Error(`Expected chain of 4 cards, got ${obj.chain?.length ?? 'none'}`);
  }
  const cardSet = new Set(CARDS.map((c) => c.name));
  const suitsSeen = new Set();
  for (const entry of obj.chain) {
    if (!cardSet.has(entry.cardName)) {
      throw new Error(`Unknown card: ${entry.cardName}`);
    }
    if (suitsSeen.has(entry.suit)) {
      throw new Error(`Suit ${entry.suit} appears twice in chain`);
    }
    suitsSeen.add(entry.suit);
    const expectedHero = SUIT_BINDING[entry.suit]?.hero;
    if (entry.targetHero !== expectedHero) {
      throw new Error(`Suit ${entry.suit} should target ${expectedHero}, got ${entry.targetHero}`);
    }
  }
  return obj;
}
