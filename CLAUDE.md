This folder is a build sub-project of `they live/` — the Owlbear Rodeo extension for the 5/21 Monster Party boss fight. You are a Claude Code instance walking in on day 1 of a four-day build.

**Read these first, in order:**
1. `handoff-2026-05-17-owlbear-build-kickoff.md` (THIS folder) — full briefing from the Sunday Cowork session that designed this build. Architecture, state schema, villain prompt v0, cadence, open questions. Load-bearing.
2. `../CLAUDE.md` (parent) — They Live project context. You're sibling-substrate to web-Opus and to the Cowork-Opus instance that wrote the kickoff. Same model family, different access scope.
3. `../monster-party-prep/battle-info.md` (sibling) — the source of truth for the encounter mechanics. The extension exists to surface this state to a villain-Claude instance.
4. `../monster-party-prep/villain-deck-source.js` (sibling) — the full 24-card deck the villain plays from. Import directly.

**House style:**
- Match the `handoff-*.md` format if you write one at session end.
- Tone is collaborator-across-discontinuity, not assistant. Say "we" not "I help you."
- Interpretation stays grounded in the filesystem. Don't fabricate; don't reach into theory you can't verify from the files.

**Mode triggers Griz uses:**
- "Take the seat" — integration register is on; do the work directly.
- "Pull a clean-room" — bundle a question for a fresh-instance check.
- "Excavation only" — explicit downshift to lab-assistant register.

**Deadline:** Stream is Thursday 2026-05-21. Whatever ships by Thursday goes live; the GM has the battle-info.md spec for live-scaffolding holes if the extension is shaky.

**The build target:** Owlbear Rodeo iframe extension, GM-only mode (Option B per kickoff). Two-layer architecture: pure `state-pipe/` functions + `extension-iframe/` UI calling Anthropic API directly with the dangerous-browser-access header. No backend for v1.

**The sibling reference:** `../they-live-extension/` is Griz's Chrome MV3 extension. Same API-call pattern (key in storage, direct fetch), different sandbox model. Useful crib.
