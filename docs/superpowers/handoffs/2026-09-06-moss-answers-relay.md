# Handoff: issue 2349, Moss answers in the Workshop project conversation

Relay 1 of this lane. No plan written yet, no code written yet, nothing committed. This session
hit the seventy percent context warning during research and is handing off before writing the plan,
per the standing rule (one relay budget; a second relay means re-scope, not another handoff).

Worktree: `/home/ben/Jarv1s/.claude/worktrees/moss-answers`, branch `work/moss-answers`.
Coordinator: agent name `coordinator` (confirm with `herdr agent list` before messaging — resolve
fresh, do not trust a pane number written here).
Issue: `motioneso/moss#2349` (already open, read in full this session; see body below, do not
re-fetch it).

## Do this next, in order

1. Run `pnpm install` only if `node_modules` is missing (it should already be present).
2. Write the plan using the `plan-build` skill format (decisions and signatures only, no
   function bodies) at `docs/superpowers/plans/2026-09-06-workshop-project-reply.md`, using the
   design below. Read `plan-build`'s own instructions by section if anything is unclear; do not
   re-read this handoff's citations against the tree again, they were checked this session.
3. Message the coordinator with the plan path and wait for approval before touching code.
4. Build task by task, commit per task, using `superpowers:test-driven-development`.
5. Close out with `coordinated-wrap-up`: gate, push, PR, live-path proof comment, release note
   section, app map declarations kept true in the same PR.

## The issue, in plain terms

Today saving a message in a Workshop project conversation shows it as "awaiting delivery" and
nothing ever answers. Build the reply: Moss answers each saved message using a persona built from
a fixed role-text (below) and the project's own context, the reply is stored in the project feed
like any other entry, and the original message stops saying "awaiting delivery" once answered.
Ask the router for the interactive tier explicitly. No planning, no tools, no builds — plain text
reply only, that is a separate later piece of work. Proof required: a real reply appearing in a
project conversation on the development instance, walked through the real screen, posted on the
pull request. Screens slice 4 will restyle this same project page later — land a plain row, do not
style it.

## Design decided this session (verified against the current tree)

**Chosen approach: synchronous reply, no new job queue, no new worker.** Right after the user's
message is saved in the existing POST handler, attempt the AI reply in the same request, wrapped so
a failure (no model configured, provider error) leaves the message "pending" exactly as today —
that already matches the manifest's documented feature text ("saved messages await delivery while
the Workshop assistant is unavailable" — `packages/workshop/src/manifest.ts:82`). This avoids
inventing pg-boss queue/worker plumbing (workshop has none today — manifest `queueDefinitions: []`
at `packages/module-registry/src/index.ts:2656`) and keeps this a one-package change plus one
call site in the registry. If the plan step disagrees and prefers an async pg-boss job instead,
that is a real fork — flag it to the coordinator rather than deciding silently; the reasoning
above is a recommendation, not a ruling.

**Why synchronous does not break the existing UAT test**
`tests/uat/specs/workshop-project-entry.uat.spec.ts:99` asserts `"Saved · awaiting delivery"` is
still visible right after a reload following save, in the default CI environment (not gated behind
a real-chat env file). Because the reply attempt fails closed (no model configured in that default
env → catch → leave pending), that assertion should keep passing unchanged. Confirm this holds
when the gate runs; do not silently rewrite that test's expectation without checking why first.

### Data model (needs a new migration)

Current row, `packages/workshop/sql/0224_workshop_project_feed.sql:9-13`:
```sql
kind TEXT NOT NULL DEFAULT 'user_message' CHECK (kind = 'user_message'),
text TEXT NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 16384 AND btrim(text) <> ''),
delivery TEXT NOT NULL DEFAULT 'pending' CHECK (delivery = 'pending'),
```
Only `SELECT, INSERT` granted to `jarvis_app_runtime` (line 28), no `UPDATE`.

New migration `packages/workshop/sql/0225_workshop_project_feed_reply.sql` needs to:
- Widen the `kind` check to allow `'assistant_message'` (verify the auto-generated constraint name
  is `workshop_project_feed_kind_check` before writing `DROP CONSTRAINT` — check
  `information_schema` or a prior similar migration in this repo for the naming convention actually
  used; do not guess blind).
- Widen the `delivery` check to allow `'delivered'` alongside `'pending'`.
- `GRANT UPDATE (delivery) ON app.workshop_project_feed TO jarvis_app_runtime;` — the plan updates
  the original user-message row's `delivery` from `'pending'` to `'delivered'` in the same
  transaction that inserts the new assistant row, once the reply succeeds.
- Assistant rows get their own `message_id` (`crypto.randomUUID()` server-side, not client-supplied)
  and `delivery = 'delivered'` always.

Shared types to widen, `packages/shared/src/workshop-api.ts:10-16` (`WorkshopFeedEntry.kind` from
literal `"user_message"` to `"user_message" | "assistant_message"`, `.delivery` from literal
`"pending"` to `"pending" | "delivered"`), and the matching JSON schema at
`workshopFeedEntrySchema` (`packages/shared/src/workshop-api.ts:281-294`, currently
`const: "user_message"` / `const: "pending"` — change to `enum`).

### Server-side reply logic

New code lives in `packages/workshop/src/` (new file, e.g. `project-reply.ts`), called from the
POST route after `feed.append` succeeds and only when `created` is true (skip on idempotent
retry), in `packages/workshop/src/project-routes.ts:173-180`.

Router call pattern to copy (this is the one that already handles both CLI and API-key transport,
unlike the simpler HttpApiAdapter-only pattern in `packages/chat/src/jobs.ts`):
`packages/module-registry/src/built-in-module-helpers.ts:66-171`
(`createDefaultPersonaPreview`). Reuse its shape:
`aiRepository.selectModelForCapability(scopedDb, "chat", "interactive")` (note: call
`selectModelForCapability` directly with an explicit `"interactive"` tier argument, not
`selectChatModelForUser`, per the issue's "ask the router explicitly for the interactive tier" —
confirmed available at `packages/ai/src/repository.ts:723-734`), then
`selectProviderWithCredential`, then branch on `provider.auth_method === "cli"` using
`createCliStructuredAdapterFactory()` (workers/route code can construct this directly — see
`packages/module-registry/src/index.ts:1663` for a worker doing exactly that; it does not need to
be threaded through `BuiltInWorkerDependencies`, which has no such field, only
`BuiltInRouteDependencies` does at line ~631) vs `HttpApiAdapter` + `generateChat` otherwise
(both branches shown in full in `built-in-module-helpers.ts:113-168`).

On any failure (no model, no provider, no credential, adapter throws): catch, log, return without
changing delivery — the row stays `'pending'`, matching current documented behavior. Never throw
out of the POST handler for this — the user's save must still succeed and return 201/200
regardless of whether the reply worked.

### Persona / role text

There is no runtime "assessment" entity in code — "the assessment" is a design doc,
`docs/reviews/2026-09-04-workshop-assessment.md` (not in the working tree; read via
`git show 04f870fe0:docs/reviews/2026-09-04-workshop-assessment.md`, "Proposed Workshop assistant
instructions" section). Its role text (quote exactly, this is the persona source the issue means):

> You are the assistant for this Workshop project. You help the user design, build, test, and
> refine its Moss module. Keep the conversation focused on that module and retain its agreed
> requirements and current plan. Ask focused questions when an answer changes the result;
> otherwise make reasonable choices and explain them briefly. [... full text continues in the doc,
> covers building/mockups/checks that are OUT OF SCOPE for this issue] ... Never claim success
> from a plan, written files, or compilation alone. Keep broader shipping an explicit human action.

Since this issue is plain conversational reply only (no tools, no builds, no planning), the plan
should either use the full text as a fixed system-style preamble (harmless even though most of it
describes later capabilities — it just means the model over-qualifies itself into a builder
persona that today can't build anything) or trim it to the parts that apply now, and say plainly
in the plan which choice it made and why. Combine it with the project's own context: `context` and
`initialRequest` fields, `packages/shared/src/workshop-api.ts:18-25` (`WorkshopProject`), fetched
via the existing `WorkshopProjectsRepository`. There is a working persona-render precedent to copy
the shape of (not the content): `renderPersonaText` used in the same
`createDefaultPersonaPreview` call site above.

### Front end

`packages/workshop/src/web/project-pages.tsx:370-376` is the feed render loop; line 373 has the
literal `"Saved · awaiting delivery"` meta text — make it conditional on `delivery === "pending"`
for `user_message` rows, and render `assistant_message` rows as their own plain card (issue says
land a plain row, do not style beyond what's needed — screens slice 4 restyles this later).
Data comes from `useInfiniteQuery` via `packages/workshop/src/web/project-client.ts:31-34`
(`listMessages`) — currently no polling; since the reply now happens synchronously inside the same
POST request as the save, the existing `onSuccess`/mutation invalidation after saving a message
should be enough to show the reply on the same round trip without adding new polling
infrastructure. Confirm this in the plan rather than assuming.

### Wiring checklist for the plan to include explicitly

- App map: `packages/workshop/src/manifest.ts` feature text at lines 77-104 currently documents the
  no-reply state ("saved messages await delivery while the Workshop assistant is unavailable") —
  update it to describe the new behavior, and add any new error code if the plan introduces one
  (e.g. a reply-failed observability event) per the "Keep Moss's app map truthful" hard gate.
- Release note section of the PR template must be filled in (user-facing: Category Added).
- No provider or model name anywhere in code — capability/tier only (`"chat"` / `"interactive"`).
- UAT: extend or add a spec under `tests/uat/specs/`, modeled on
  `tests/uat/specs/workshop-chat-handover.uat.spec.ts` (gated behind
  `JARVIS_UAT_REAL_CHAT_ENV_FILE` since it needs a real configured chat provider to prove a real
  reply) — this is the live-path proof the issue demands. Do not rely solely on the existing
  ungated `workshop-project-entry.uat.spec.ts`, which must keep passing unchanged (see above).

## Guardrails already given for this lane (do not relitigate)

- Never pipe a gate command; never run the full gate or any DB-touching test without the
  `verify-gate` skill (default DB is the live dev one).
- Never a repository-wide format or a broad `git add`; never touch `docs/coordination`.
- Do not merge or rebase `build/workshop-phase-a-0904`, do not push to it; copy files out if
  needed.
- Plain English in every message a human reads: status updates, this doc, spawn prompts — no
  jargon, no invented shorthand, plain keyboard punctuation, at most one piece of code formatting
  per sentence. Pass this rule on to every agent you spawn, word for word.
- Dev instance: `http://192.168.50.36:5173`, API port 3000, login `ben@ben.com` (password in
  memory, not repeated here). Port 1533 is production, never a test target.
- Your own slice must finish this session. A second relay is not available — if it still does not
  fit, report to the coordinator for a re-slice instead of relaying again.
