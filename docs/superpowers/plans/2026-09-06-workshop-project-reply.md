# Workshop project reply — Moss answers in the project conversation

Task #2349. Approved parent spec: `docs/superpowers/specs/2026-09-04-workshop-projects-and-supervised-builds.md`
("Assistant and models" section, project-scoped assistant with its own instructions).

Today saving a message in a Workshop project conversation shows "awaiting delivery" forever.
This slice makes Moss answer: right after a user message is saved, try an AI reply in the same
request; on success, store it as a new feed row and mark the user's row delivered; on any failure,
leave the row pending exactly as today. No tools, no planning, no builds — plain text only.

## Seams and contract (verified this session, do not re-check)

- Workshop has no queue or worker (`queueDefinitions: []`,
  `packages/module-registry/src/index.ts:2656`) — reply happens synchronously in the POST handler,
  no new pg-boss plumbing.
- Router call pattern to copy: `createDefaultPersonaPreview`,
  `packages/module-registry/src/built-in-module-helpers.ts:66-171`. Call
  `aiRepository.selectModelForCapability(scopedDb, "chat", "interactive")` directly (explicit
  interactive tier, not `selectChatModelForUser`) — `packages/ai/src/repository.ts:723-734` — then
  `selectProviderWithCredential`, then branch on `provider.auth_method === "cli"`:
  `createCliStructuredAdapterFactory()` (built directly at the call site, precedent
  `packages/module-registry/src/index.ts:1663`; `BuiltInRouteDependencies` carries this, not
  `BuiltInWorkerDependencies`) vs `HttpApiAdapter` + `generateChat`.
- Current feed row: `packages/workshop/sql/0224_workshop_project_feed.sql:9-13`, `kind` locked to
  `'user_message'`, `delivery` locked to `'pending'`, only `SELECT, INSERT` granted to
  `jarvis_app_runtime`.
- POST route: `packages/workshop/src/project-routes.ts:173-180`, after `feed.append` succeeds, only
  when `created` is true (skip on idempotent retry).
- Front end feed render: `packages/workshop/src/web/project-pages.tsx:370-376`, line 373 has the
  literal `"Saved · awaiting delivery"` text. List query:
  `packages/workshop/src/web/project-client.ts:31-34` (`listMessages`), no polling today; existing
  post-save mutation invalidation is enough since the reply is now in the same round trip.
- Persona role text: quoted from `docs/reviews/2026-09-04-workshop-assessment.md` ("Proposed
  Workshop assistant instructions" section, read via
  `git show 04f870fe0:docs/reviews/2026-09-04-workshop-assessment.md`), trimmed to the parts that
  apply to a plain conversational reply with no tools/builds/planning (opening framing sentences
  only — drop everything about building, mockups, and checks, which this slice cannot do).
- Manifest feature text documenting the no-reply state:
  `packages/workshop/src/manifest.ts:77-104` ("saved messages await delivery while the Workshop
  assistant is unavailable") — must be updated in this PR (app map truthfulness gate).

## Determinism boundary

The model's only job: write one plain-text reply to the user's saved message, given the persona
text and the project's `context`/`initialRequest` fields. Nothing else is model-authored — the
"delivered" transition, the stored row, and the UI text are all set deterministically by the server
after the model call returns (or fails). No guidance prompt beyond the persona text itself.

## Data model — new migration

`packages/workshop/sql/0225_workshop_project_feed_reply.sql`:

- Find the live constraint names first (`information_schema.check_constraints` or a prior migration
  in this repo widening a similar CHECK) before writing `DROP CONSTRAINT` — do not guess the name.
- Widen `kind` CHECK to allow `'assistant_message'` alongside `'user_message'`.
- Widen `delivery` CHECK to allow `'delivered'` alongside `'pending'`.
- `GRANT UPDATE (delivery) ON app.workshop_project_feed TO jarvis_app_runtime;`
- Assistant rows: server-generated `message_id` (`crypto.randomUUID()`, never client-supplied),
  `delivery = 'delivered'` always, same per-project sequence counter as user rows.

## Shared types

`packages/shared/src/workshop-api.ts:10-16` — `WorkshopFeedEntry.kind` widens from the literal
`"user_message"` to `"user_message" | "assistant_message"`; `.delivery` widens from the literal
`"pending"` to `"pending" | "delivered"`. Matching JSON schema `workshopFeedEntrySchema`
(`packages/shared/src/workshop-api.ts:281-294`): change `const: "user_message"` to
`enum: ["user_message", "assistant_message"]`, `const: "pending"` to
`enum: ["pending", "delivered"]`.

## Server-side reply

New file `packages/workshop/src/project-reply.ts`:

```ts
export interface ProjectReplyResult {
  delivered: boolean;
  assistantEntry?: WorkshopFeedEntry;
}

export async function attemptProjectReply(
  db: DataContextDb,
  deps: { aiRepository: AiRepository; adapters: BuiltInRouteDependencies },
  project: WorkshopProject,
  userEntry: WorkshopFeedEntry
): Promise<ProjectReplyResult>;
```

Behavior: select model for capability `"chat"` tier `"interactive"` -> select provider with
credential -> build persona text from the fixed role text plus `project.context` and
`project.initialRequest` -> call the CLI or HTTP adapter for a plain-text completion -> on success,
in one transaction insert the assistant feed row and update the user row's `delivery` to
`'delivered'` -> return `{delivered: true, assistantEntry}`. On any thrown error at any step: catch,
log at warn level with project id and error message only (no prompt or reply content in logs),
return `{delivered: false}` without mutating any row. Never throws out of `attemptProjectReply`.

Call site: `packages/workshop/src/project-routes.ts:173-180`, after `feed.append` returns
`created: true`, call `attemptProjectReply` and await it before responding (still one HTTP
round trip); the route's response body is unaffected by whether the reply succeeded, since the
client re-fetches the list.

## Front end

`packages/workshop/src/web/project-pages.tsx`:

- Line 373: wrap `"Saved · awaiting delivery"` in a check for `entry.delivery === "pending"` on
  `user_message` rows only.
- Add a plain, unstyled render branch for `kind === "assistant_message"` rows (no new `jds-*`
  usage beyond what the existing user-message row already uses) — screens slice 4 restyles this
  page later.

## App map and manifest

`packages/workshop/src/manifest.ts:77-104` — rewrite the feature text to describe the new behavior
(assistant replies inline; falls back to pending on failure), matching the "Keep Moss's app map
truthful" gate.

## Release note

Category: Added. Title: "Moss replies in project conversations." Description in plain English, no
file paths or code names — something like: "Messages you save in a Workshop project now get a
reply from Moss instead of staying stuck as awaiting delivery."

## Verification

1. `scripts/run-gate.sh start --gate test:workshop-projects --exclusive` via the `verify-gate`
   skill, then `wait --follow`. Expected rc 0. New/extended unit or integration cases:
   - reply succeeds: user row flips to `delivered`, assistant row appears with `delivered` always,
     both share the project's sequence counter.
   - no model configured / provider error / adapter throws: user row stays `pending`, no assistant
     row inserted, POST still returns success.
   - idempotent retry (`created: false`): `attemptProjectReply` is not invoked a second time.
2. Root/test TypeScript, scoped lint/format, package and app-map checks must pass as part of the
   same gate run.
3. UAT: extend `tests/uat/specs/workshop-chat-handover.uat.spec.ts`'s pattern (gated behind
   `JARVIS_UAT_REAL_CHAT_ENV_FILE`, needs a real configured chat provider) with a new spec proving
   a saved project message gets a real Moss reply and the pending text clears. Confirm
   `tests/uat/specs/workshop-project-entry.uat.spec.ts:99` (asserts `"Saved · awaiting delivery"`
   still visible after reload, in the default env with no provider configured) keeps passing
   unchanged — do not edit that assertion without first proving why it broke.
4. Live-path proof: on the development instance (`http://192.168.50.36:5173`), save a message in a
   real Workshop project conversation, see Moss's reply appear and the pending text clear. Record
   this on the pull request per the live-path gate.

Kill gate: if `attemptProjectReply` cannot get a working CLI or HTTP adapter for any configured
provider on the dev instance during live-path testing (not just "no provider configured", but a
call that should work and doesn't), stop and report to the coordinator rather than loosening the
fail-closed contract or reaching into unrelated provider/adapter code. Owner: this session.

## Note for the next session: the model call, worked out but not yet typed in

Package `packages/workshop` needs `@moss/ai` added as a dependency (precedent for a feature
package calling the model directly: `packages/tasks/src/search-interpret-route.ts`).

Split the work into three steps so a slow model never holds a database lock or leaves the save
waiting past a fixed limit:

1. **Pick the model and provider** in one short database call: `aiRepository.selectModelForCapability(scopedDb, "chat", "interactive")`, then `selectProviderWithCredential`. This is quick, no network call, so it is fine inside a short transaction. Return which of the two routes below applies, plus what that route needs (nothing else — do not keep the transaction open past this point).
2. **Get the reply text**, outside of any database transaction, so a slow or hung model never holds a connection or a lock:
   - Command line tool login (`provider.auth_method === "cli"`): build the adapter with `createCliStructuredAdapter(kind)` (passed in from the route registration in `packages/module-registry/src/index.ts`, which already has this factory available — see `deps.createCliStructuredAdapter` on `BuiltInRouteDependencies`), then call `.generateStructured({ model, messages, schema: {type:"object", properties:{text:{type:"string"}}, required:["text"], additionalProperties:false}, maxOutputTokens })`. Read the reply the same way `readPersonaPreviewResult` does in `packages/module-registry/src/built-in-module-helpers.ts:173`.
   - Stored key (anything else): `new HttpApiAdapter(kind, apiKey, {baseUrl})` then `.generateChat({model, messages, maxOutputTokens})`, reading `.text` from the result. Decrypt the stored key first with `parseAiApiKeyCredential(cipher.decryptJson(provider.encrypted_credential))`.
   - Wrap whichever call in a race against a timer (about 45 seconds). If the timer wins, treat it exactly like a failure — the row stays pending, nothing is written, and the leftover model call is left to finish or fail in the background with its own error caught and logged so it cannot crash the process.
3. **Write the result** in a second short database call: `feed.appendAssistantReply(scopedDb, projectId, replyText, userMessageId)` — this method already exists and is committed (see `packages/workshop/src/project-feed.ts`).

Any failure at any step (no model configured, no provider, no credential, the call itself throwing,
or the timer running out) must be caught and simply mean "leave it pending" — never let it stop the
save from succeeding.
