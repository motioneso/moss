# #1705, #1706 — Pinned Context and Proactive Auto-Save

**Date:** 2026-08-19

**Status:** Draft — needs approval

**Issue:** [#1705](https://github.com/motioneso/moss/issues/1705), [#1706](https://github.com/motioneso/moss/issues/1706)

## Context

Moss's own dogfood feedback described starting every conversation cold: facts the user has already
disclosed (name, timezone, family, employment, active goals) do not reliably show up in a new
conversation unless the current turn's query happens to score high enough against them. Two related
gaps were reported and triaged together:

- **#1705** asks for an always-loaded pinned context block and a pinned memory tier, so some facts
  return regardless of query relevance.
- **#1706** asks that durable facts (salary, account balance, a major life event) get saved reliably
  instead of depending on the assistant remembering to call a save tool mid-turn.

Triage on both issues (2026-08-19) found that most of the mechanism #1705 asks for already exists,
just not wired into live chat:

- `app.memory_facts` already has a `pinned` boolean column, settable through `pinFact()`
  (`packages/memory/src/graph-repository.ts:573`).
- `listCoreFacts()` (same file, `packages/memory/src/graph-repository.ts:485`) already returns up to
  a caller-supplied limit of active facts ordered by `pinned DESC, importance DESC,
last_confirmed_at DESC NULLS LAST, updated_at DESC`, filtered to rows where `(pinned = true AND
confidence >= 0.70) OR provenance = 'confirmed' OR confidence >= 0.80`. That is precisely the
  "always relevant regardless of query" set #1705 is asking for.
- Today `listCoreFacts()` is called only from the background distillation job
  (`packages/chat/src/jobs.ts:209`, requesting up to 30 facts to avoid re-extracting facts the
  assistant already knows). It is never called from the live turn's context builder,
  `buildEngineText()` (`packages/chat/src/live/engine-text.ts`), which today only performs scored
  passive retrieval through `packages/chat/src/live/passive-retrieval.ts` — capped at 8 items, 1200
  tokens, and a 0.35 minimum relevance score (`packages/chat/src/live/passive-retrieval.ts:35-39`).

That gap is the entire core of #1705: the pinned/high-confidence tier exists in storage and query
form, but the live turn never asks for it.

For #1706, the mid-turn save path already exists as an assistant tool
(`memoryRememberExecute` in `packages/memory/src/graph-tools.ts`), but it only fires when the model
chooses to call it during the turn. There is no dedicated durable-fact extraction pipeline today.

## Goals

1. Every live chat turn includes a bounded, always-present block of the user's pinned and
   high-confidence facts, independent of whether the current message's query would have scored those
   facts high enough for passive retrieval.
2. The pinned block and passive retrieval remain visibly separate budgets so pinned facts cannot
   crowd out query-relevant recall, and vice versa.
3. A durable fact the user discloses in conversation is markedly more likely to be saved and
   available in later conversations, without depending solely on the model remembering to call the
   save tool mid-turn.
4. #1706's mechanism reuses #1705's existing confidence/pinned bar (`listCoreFacts`'s inclusion
   rule) as the definition of "durable" rather than introducing a second, parallel notion of what
   counts as an important fact.

## Non-Goals

- A UI for manually browsing, editing, or bulk-managing pinned facts. (`pinFact()` already exists as
  a data-layer primitive; a settings surface for it is a separate scope decision.)
- Deciding, in this spec, whether pinning is user-initiated, assistant-inferred, or both. See Open
  Questions.
- Deciding, in this spec, whether #1706 is satisfied by prompt-only reinforcement, a full
  post-turn server-side extraction pipeline, or both. See Open Questions.
- Any change to `passive-retrieval.ts`'s existing scored-recall behavior, budget, or thresholds.
- Any change to the distillation job's existing use of `listCoreFacts()`.
- Cross-user or shared facts. Pinned/core facts remain owner-scoped exactly as today.

## Resolved Decisions

| Decision                  | Choice                                                                                                                             | Reason                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned-tier source        | Reuse `listCoreFacts()` as-is                                                                                                      | It already implements the inclusion rule (pinned/confirmed/high-confidence) and ordering #1705 needs; no new query or table.                                                       |
| Live-turn wiring          | Call `listCoreFacts()` from `buildEngineText()` alongside the existing passive-retrieval call                                      | Keeps `buildEngineText()` as the single place that assembles hidden context for a turn; avoids a second context-assembly path.                                                     |
| Budget separation         | Give the pinned block its own token budget, separate from passive retrieval's existing 1200-token / 8-item cap                     | Prevents a busy pinned tier from starving query-relevant recall, and vice versa; matches the issue's ask for an independent "always relevant" set.                                 |
| #1706 mechanism direction | Extend `listCoreFacts()`'s confidence-based inclusion rule as the durable-fact bar, rather than building a new extraction pipeline | The pinned tier already defines "important enough to always surface"; a fact durable enough to auto-save is a strong candidate for that same tier, per the issues' own cross-link. |
| #1706 extraction approach | Not decided in this spec                                                                                                           | Open question — see below.                                                                                                                                                         |

## Architecture

### Pinned block wiring (#1705)

`buildEngineText()` gains a call to `listCoreFacts(scopedDb, actorUserId, <limit>)`, run alongside
(not instead of) the existing passive-retrieval call. The result is rendered into its own hidden-
context block, separate from the passive-retrieval block, and combined with it the same way
`combineHiddenContextBlocks()` already combines the passive-retrieval and cross-tool-reasoning
blocks today.

The pinned block:

- Is present on every turn where `listCoreFacts()` returns at least one fact, regardless of the
  current message's content.
- Uses its own item/token cap, sized independently of passive retrieval's 8-item / 1200-token
  budget (exact numbers left to implementation once real fact volumes are measured; see Open
  Questions).
- Reuses `listCoreFacts()`'s existing ordering (`pinned DESC, importance DESC, last_confirmed_at DESC
NULLS LAST, updated_at DESC`) to decide which facts are kept if the result exceeds the block's
  budget, rather than inventing a second ranking.

No schema change is needed: the `pinned` column, `pinFact()`, and `listCoreFacts()` already exist.

### Durable-fact auto-save (#1706)

Direction: a fact is treated as "durable enough to always keep" using the same bar
`listCoreFacts()` already applies for the pinned tier (pinned, confirmed, or high-confidence). The
specific extraction mechanism that produces new facts meeting that bar is not chosen here — it is
the central open question of this spec (see below), because the two candidate approaches have very
different failure modes:

- **Server-side post-turn extraction** would add a new pipeline that reads each completed turn and
  proposes facts, closer to how the existing distillation job already summarizes turns. Its risk is
  false positives — saving something that was not actually a durable, confirmed disclosure.
- **Prompt-only reinforcement** would instruct the model to call the existing `memory.remember` tool
  (`memoryRememberExecute`, `packages/memory/src/graph-tools.ts`) more assertively after a
  qualifying disclosure, with no new pipeline. Its risk is that it is still optional per-turn model
  behavior, the same failure mode #1706 was filed to fix, just with stronger instructions.

Whichever mechanism is chosen, saved facts flow through the existing fact-creation path (used by
`memoryRememberExecute` and the distillation job today) so they land in `app.memory_facts` with
normal `confidence`, `provenance`, and `pinned` semantics, and become visible through
`listCoreFacts()` (and therefore the #1705 pinned block) once they clear its bar. No second
fact store or extraction result table is introduced.

## Security and Privacy

- No new data is collected; both changes route through the existing owner-scoped
  `app.memory_facts` table and its existing RLS.
- The pinned block is folded into hidden context the same way passive retrieval already is — it is
  never rendered to a user who is not the fact's owner, matching `listCoreFacts()`'s owner-scoped
  query.
- If server-side extraction is the eventual choice for #1706, it must run through the same
  actor-scoped `DataContextDb` pattern already used by `graph-tools.ts` and the distillation job, and
  must not introduce a path that writes facts for a user other than the turn's actor.
- Auto-saved facts carry the same secrets/private-data constraints as any other memory fact: no
  connector/AI credentials, auth tokens, or session tokens may be captured as fact content.

## Verification

### Focused automated checks

1. `buildEngineText()` includes a non-empty pinned block when `listCoreFacts()` returns facts, even
   when the current message would not have triggered passive retrieval on its own (e.g. a generic
   greeting).
2. The pinned block and the passive-retrieval block remain independently bounded — a large pinned
   set does not shrink passive retrieval's existing 1200-token / 8-item budget, and vice versa.
3. A user's pinned/core facts never appear in another user's `buildEngineText()` output (owner
   scoping).
4. Whatever #1706 mechanism is chosen has coverage proving a qualifying disclosure results in a
   saved fact that later clears `listCoreFacts()`'s bar, and a non-durable, incidental statement does
   not get auto-saved.

### Required live-path proof

On the exact implementation head, in a live authenticated conversation:

1. Establish a pinned or high-confidence fact (e.g. pin an existing fact, or have a prior
   conversation establish a confirmed one).
2. Start a new conversation with an unrelated opening message and confirm the assistant's first
   response already reflects the pinned fact, without the user restating it.
3. Disclose a durable fact matching #1706's motivating cases (e.g. a stated life event) in
   conversation, then start a new conversation and confirm the fact is available without the user
   having asked the assistant to save it.

Record the exact steps and observed evidence on the implementation PR.

## Open Questions

- **How does a fact become pinned?** Explicit user action (a settings surface calling `pinFact()`),
  assistant-inferred pinning during a turn, or both? Not decided here.
- **Staleness and expiry of pinned facts.** `listCoreFacts()` already excludes facts past `stale_at`
  or `valid_to`, but whether pinned facts need a distinct review/expiry policy (e.g. periodic
  re-confirmation) is unresolved.
- **Pinned-block token budget.** The right size relative to passive retrieval's existing 1200-token
  cap is not chosen here; it should be set from real fact volumes during implementation.
- **#1706 extraction approach.** Server-side post-turn extraction vs. stronger prompt-only
  reinforcement of the existing `memory.remember` tool is the central undecided question of this
  spec.
- **False-positive risk of server-side extraction.** If that path is chosen, what guards against
  over-saving incidental statements as durable facts (e.g. requiring a minimum confidence, a
  confirmation step, or scoping extraction to a narrow set of fact types) is unresolved and flagged
  for a follow-up decision rather than resolved here.
- **Interaction with the distillation job.** The distillation job already reads `listCoreFacts()` to
  avoid re-extracting known facts (`packages/chat/src/jobs.ts:209`). Whether a new #1706 extraction
  step lives inside that job, alongside it, or fully separately is unresolved.

## Exit Criteria

- `buildEngineText()` folds `listCoreFacts()` results into a bounded, always-present hidden-context
  block on every live turn, independent of the current message's passive-retrieval score.
- The pinned block and passive retrieval use separate, independently enforced budgets.
- A chosen #1706 mechanism (decided in a follow-up to this spec's open questions, or in a revision of
  it) reuses `listCoreFacts()`'s inclusion rule as the durable-fact bar rather than a second parallel
  rule.
- No new fact-storage table, schema change, or second extraction result store is introduced beyond
  what `app.memory_facts` already supports.
- Live-path evidence recorded on the implementation PR shows a pinned/core fact appearing unprompted
  in a new conversation, and a durably disclosed fact surviving into a later conversation without an
  explicit save request.

## Hard Invariants Honored

- Spec before build: this document must be approved, and its open questions resolved or explicitly
  deferred, before an implementation plan is written.
- Private by default / no admin bypass: all reads and writes stay owner-scoped through existing RLS;
  no new admin or cross-user path is introduced.
- Secrets never escape: auto-saved and pinned facts remain ordinary fact content, never credentials,
  tokens, or hashes.
- Module isolation: the change is confined to the memory and chat packages' existing public
  functions (`listCoreFacts()`, `buildEngineText()`, `memoryRememberExecute`); no new cross-module
  table access is introduced.
