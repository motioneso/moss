# Chat context continuity and default notes retrieval

**Date:** 2026-08-10

**Status:** Draft, revised 2026-08-10 after Codex adversarial review
(`docs/coordination/2026-08-10-1553-1554-codex-review.md`) — pending Ben sign-off

**Parent issues:** #1553 (continuity); the retrieval half resolves the _passive retrieval gap_
diagnosed in #1248's 2026-08-10 comment. Internal-vault ingestion stays on #1248 — see Non-goals.

**Grounded on:** `origin/main` = `128a5bed6`; issue #1553; issue #1248 body + 2026-08-10 comment;
code fact-check of the replay and passive-retrieval paths (this session, 2026-08-10).

**Consumed by:** the persistent-runtime spec (#1554) — its crash recovery invokes this spec's
replay contract and must not redefine it.

## Decision summary

Two fixes to _what the model knows when it answers_, shipped together because they share the
context-assembly seam:

1. **Replay on relaunch stops defaulting to zero.** Whenever a live engine is (re)launched under a
   thread that has persisted history, Moss re-feeds a bounded window of that history: the **last
   40 persisted messages (~20 exchanges), capped at ~8,000 tokens**, dropping oldest whole
   messages past either bound. On by default. If a stored `conversation_summary` exists it is
   prepended read-only; _generating_ summaries stays out of scope — and because current code
   couples summary generation to the same knob, decoupling is an explicit part of the contract.
2. **Notes become the default reflex, not an option.** The persona gains a standing
   **search-before-asking** rule — when a question touches the user's stored information, the
   model searches the notes before asking the user. Underneath it, the pre-turn passive-retrieval
   step is extended to query the **notes index** alongside graph facts and inject a bounded set of
   relevant snippets, so the floor no longer depends on the model choosing to search.

Recovery/relaunch events are visible in server logs only — never in the thread, never as
assistant prose. Incognito threads get **neither** replay nor notes injection.

## Current-state grounding

- `getReplayK()` (`packages/chat/src/live/persistence.ts:419-424`) returns **0** when
  `JARVIS_CHAT_REPLAY_K` is unset — replay is disabled by default. This is the #1553 incident: a
  78-message thread relaunched with empty model context. `getSwitchReplayK()` defaults to 10 but
  only applies on `forceReplay`.
- `launchSession()` (`packages/chat/src/live/chat-session-manager.ts:212-295`) already calls
  `listPriorTurns()` at `:246`; the plumbing exists and is starved by the zero default.
- **Coupling trap:** `getReplayK()` also gates the summary _write_ path — `persistence.ts:240-260`
  writes `conversation_summary` whenever `k > 0`, and `:183-185` synthesizes
  `buildRollingSummary(...)` at read time when none is stored. Raising the default without
  severing this coupling silently turns on summary generation.
- Automatic pre-turn injection exists but is **graph-facts only**: `buildEngineText`
  (`packages/chat/src/live/engine-text.ts:57-73`) → `PassiveContextRetriever`
  (`packages/chat/src/live/passive-retrieval.ts`), whose both recall call sites hit
  `graphRecall.recall(...)` exclusively. Nothing queries the notes index.
- The notes plumbing already works: chat can call `notes.search` (granted via `mcp__jarvis__*`)
  and read the Obsidian roots read-only (`vaultReadOnlyToolPatterns()`,
  `packages/chat/src/live/vault-allowlist.ts:18-25`). Call notes Moss writes land in the Obsidian
  store via `notes.create`/`notes.edit` and **are** indexed by notes-sync. The 2026-08-10 misses
  (Friday-call, GC info) were fully retrievable content that nothing defaulted into the turn.
- The persona base (`DEFAULT_MOSS_PERSONA`, `packages/chat/src/live/runtime.ts:65`, composed into
  the engine persona at `:523`) contains no retrieval guidance at all.
- Threads carry a server-truth `incognito` flag (`packages/chat/src/live-routes.ts`).

## Goals

- A relaunched engine under a persisted thread continues the conversation; the user cannot tell
  from _content_ that a relaunch happened.
- A question whose answer sits in the user's notes gets answered from the notes — asking the user
  becomes the fallback, not the first move.
- Both behaviors bounded and deterministic: fixed turn/token windows, fixed snippet budget,
  oldest-whole-turn truncation, no unbounded context growth.
- Incognito semantics preserved: private means nothing is re-fed or injected from storage.

## Non-goals

- Summary _generation_ or refresh (consume `conversation_summary` if present; never write it).
- Internal-vault ingestion (`IngestionService.ingestVault` still has no production caller) —
  attachments/people-notes/exports remain unsearchable until #1248's ingestion work; this spec
  must not grow to include it.
- Broad vault retrieval/RAG architecture (#1248), Markdown transcript export (#1368),
  unbounded replay, cross-thread or cross-user retrieval of any kind.

## Design

### Replay contract (the half #1554 consumes)

- **Trigger:** every engine (re)launch under a thread with persisted turns — crash recovery,
  idle-reap restart, container restart, provider/model switch. One code path; `forceReplay`'s
  separate default collapses into it.
- **Replay unit and window:** the unit is one persisted message as returned by `listPriorTurns`
  (`{ role, content }`, `persistence.ts:157-185` — the code calls each individual message a
  "turn"). Selection: newest-first take of the last **40 messages**, then trim oldest whole
  messages until the window fits **8,000 estimated tokens**. The estimator input is the exact
  serialized string re-fed to the engine for that message (role prefix + content), using the
  existing deterministic estimator (`packages/chat/src/live/recall-seed.ts:28-31`); the cap is a
  safety bound, not an accounting guarantee. Edge rules: a single newest message larger than the
  whole cap is truncated head-first (tail kept) so something always replays; an unpaired
  user-only message replays as-is (no pairing logic); ordering is always persisted chronological
  order. Normative example: 50 messages of ~300 estimated tokens each → the 40-message window
  token-trims to the newest 26 → messages 25–50 replay in chronological order.
- **Summary (read-only, decoupled):** if a stored `conversation_summary` is non-empty it is
  prepended _outside_ the 8k window with its own 1,000-token cap (truncate tail). Absent →
  skipped, nothing synthesized. Overlap with the replay window is acceptable — the summary is
  advisory preamble, not accounting. **Decoupling is part of this contract:** the current
  `k > 0`-gated summary write and read-time `buildRollingSummary` synthesis
  (`persistence.ts:240-260`, `:183-185`) are severed from the replay-window setting, so the new
  default writes and generates nothing. Summary generation stays owned by its own future feature.
- **Order and shape:** messages re-fed in chronological order in the engine's native replay
  format (existing `listPriorTurns` shape). Only persisted user/assistant **text** is replayed —
  completed-turn persistence stores text plus metadata, not structured tool calls/results
  (`persistence.ts:218-230`), so there is nothing to re-feed and nothing is re-executed. A
  sanitized structured-history contract (schema, redaction, retention) is explicitly out of scope.
- **Defaults and knobs:** default ON. `JARVIS_CHAT_REPLAY_K` (with its MOSS-era alias per the
  #1443 carve-out rules) remains the operator override; `0` remains a valid explicit opt-out.
  The _default-when-unset_ changes from 0 → 40 messages. Token cap gets a sibling env override.
- **Incognito:** threads with `incognito = true` replay nothing. If the engine relaunches, the
  conversation is gone — that is the feature.
- **Visibility:** relaunch + replay emit structured log events (thread id, turn count, token
  count, trigger). Nothing is rendered into the thread.

### Notes retrieval defaulting

- **Persona rule (the headline behavior):** `DEFAULT_MOSS_PERSONA` (composed into the engine
  persona at `runtime.ts:523`) gains a short standing
  instruction: when the user's message plausibly touches their stored information (people,
  meetings, decisions, plans, anything Moss may have written down), search the notes first
  (`notes.search`, then scoped reads if needed) and answer from what is found; ask the user only
  when search comes up empty. Phrased provider-neutrally; no vendor names.
- **Pre-turn injection (the floor):** `PassiveContextRetriever` gains a notes-recall path beside
  `graphRecall`, consuming a **declared public notes-recall port** on the notes module (a new
  public API beside the registered `notes.search` tool boundary — never notes internals or its
  tables, per module isolation). Port result contract: owner-scoped relative note path, modified
  time, score, sanitized snippet text. (Today `notes.search` returns only `sourcePath`/line
  bounds/text, `packages/notes/src/tools.ts:34-62` — the port is where provenance is added.)
  Inject at most **5 snippets** totalling at most **2,000 tokens**, each tagged with its source
  note path and modified time.
  - **Latency budget:** if notes search hasn't answered within **500 ms**, skip injection for
    that turn (the persona rule still stands). Never block a turn on retrieval.
  - **Failure:** retrieval errors are logged and skipped — a broken index must never fail a turn.
  - **Scoping:** owner-only, same RLS/actor scoping as `notes.search` itself; injected snippets
    are the actor's own notes, never another user's, never cross-thread chat content.
  - **Trust boundary:** injected snippets are wrapped in the existing untrusted-content fencing —
    `renderRetrievedContextBlock` (`passive-retrieval.ts:180-203`) plus `neutralizeSeedFraming`
    (`packages/chat/src/live/prompt-safety.ts:17-32`); they are context, not instructions.
  - **Sensitive-content filter (fail closed):** before injection every snippet passes a
    credential/secret screen (key material, token/password-shaped content). A suspect snippet is
    dropped and logged — never truncated-and-kept. Notes are user-authored and may contain
    credentials; the hard invariant (secrets never reach AI prompts) applies to passive injection
    like any other path. A regression test proves credential-shaped note content never reaches
    engine input. The pattern set is a plan decision; the fail-closed disposition is not.
  - **Gating (server truth, before any query):** the notes path runs only when the thread is not
    incognito **and** the actor's existing `recallEnabled` setting is on —
    `PassiveContextRetriever` already gates on `recallEnabled`/`factsEnabled`
    (`passive-retrieval.ts:101-125`), and notes recall obeys `recallEnabled` identically. Thread
    privacy state reaches the retriever from server truth (the thread record; `getThreadContext`,
    `persistence.ts:354-371`, is extended to carry it), never from UI state. Disabled or
    incognito ⇒ the notes port is never called — asserted at the port, not inferred from the UI.
  - **Incognito:** skipped entirely (see gating).
- **Search quality is a plan-phase research step, not a spec decision:** index search vs. direct
  file reads, ranking, freshness weighting get a small timeboxed investigation in the
  implementation plan; the spec fixes only the _bounds_ above.

## Acceptance criteria

1. **Deterministic replay-input tests (fake engine capturing exact input):** (a) a persisted
   thread replays exactly the expected message window, twice in a row, identical — exercising the
   40-message and 8k-token bounds, oldest-whole-message truncation, and the oversized-newest
   rule; (b) summary present ⇒ prepended with the 1,000-token cap applied; summary absent ⇒ no
   summary text in engine input **and no write to `conversation_summary`** (decoupling proof);
   (c) explicit `JARVIS_CHAT_REPLAY_K=0` ⇒ zero replay; (d) incognito thread ⇒ zero replay,
   asserted from engine input.
2. **Deterministic notes-injection tests (fake notes port):** (a) at most 5 snippets / 2,000
   tokens, each with path + modified-time provenance, wrapped in the untrusted-content fence;
   (b) port latency over 500 ms ⇒ turn proceeds with zero injection; (c) port error ⇒ turn
   proceeds, error logged; (d) credential-shaped snippet ⇒ dropped, never reaches engine input;
   (e) incognito or `recallEnabled` off ⇒ the port is never called.
3. **Continuity regression (live):** persist a multi-turn thread, destroy the live engine,
   relaunch, ask about earlier content — the reply demonstrates retained context. This is
   live-path evidence; the falsifiers for the contract are the fake-engine tests above.
4. **Notes-default live proof (live-path gate):** seed a note (via the real UI/tools) recording a
   fact, then in a later session ask a question whose answer is that fact _without naming the
   note_ — the assistant answers from the note. Evidence recorded on the PR.
5. **No-prose check:** forced relaunch mid-thread produces log events and zero thread-visible
   system/recovery text.

## Rollout

Default-on behavior change, no migration, no new tables. Ships behind nothing: the fix _is_ the
new default. Operator opt-out remains (`JARVIS_CHAT_REPLAY_K=0`, injection disabled via config).
Live-proof on the dev instance before merge per the live-path gate.
