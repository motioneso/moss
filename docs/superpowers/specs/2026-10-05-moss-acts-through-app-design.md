# Moss acts through its own app

- **Status:** design approved by Ben, 2026-10-05. Slice 7 passed hosted verification at
  `a77aa4744`; Slice 8 scripted browser proof passed hosted verification at `aff106749`.
  Owner-run live proof and Ben's ruling on clean Run B/no-ask browser acceptance remain outstanding.
  The later owner-descriptor trust ruling below supersedes blanket descriptor admission.
- **Issue:** #3065
- **Related:** #2998 (self-knowledge by construction), #3023 (custom themes), #3022, #3024, #3025,
  #3026, July self-operation specs (`2026-07-26-module-self-operation-settings-commands.md`,
  `2026-07-26-module-self-operation-content-commands.md`)

## Goal

Anything a user can do in Moss, Moss in chat can do too. Moss never answers "I'm not sure how to do
that" about its own app.

Ben's rulings, 2026-10-05:

- Parity comes from a general path, not one tool per action. Moss looks at its own code to work out
  how to do things.
- "Instructions outside of chat must require approval, regardless of what the instructions say."

## Where things stand

Historical pre-build baseline, measured at commit 60505036c. These counts and absence statements
are not claims about the current implementation; the Slice 7 ruling below records the later state.

| Measure                                                                                   | Count |
| ----------------------------------------------------------------------------------------- | ----- |
| Built-in chat tools                                                                       | 106   |
| User write actions the web app calls (excluding admin, sign-in, chat plumbing, approvals) | 136   |
| Fully matched by a chat tool                                                              | 31    |
| Partly matched                                                                            | 3     |
| No chat tool                                                                              | 102   |
| ...of which on the July locked list                                                       | 32    |
| Admin-only write actions (none has a tool)                                                | 57    |

Largest gaps: settings and account (20), wellness (9), connected services (8), news (8), people and
memory (12), meetings (5, no tools at all).

Facts the design rests on:

- Tools call module code directly inside `withDataContext` (`packages/db/src/data-context.ts:63`).
  Nothing calls a route from a tool. No non-test code uses Fastify `inject`.
- Route sign-in accepts a login cookie or login-session bearer only
  (`packages/auth/src/index.ts:410-470`). Chat's `jst_` tokens are refused.
- Self-operation exclusions match on module id plus tool-name prefix
  (`packages/ai/src/gateway/self-operation.ts:173-182`). A single generic tool has one name, so they
  cannot see what it targets.
- 392 manifest routes across 28 modules. 85 declare a `requestSchema`. About 336 of 402 Fastify
  registrations carry a `schema` option, capturable in the existing `onRoute` hook
  (`apps/api/src/server.ts:345`). About 100 platform routes sit on an allowlist with no manifest
  entry (`packages/module-registry/src/route-guard.ts:35-172`).
- `permissionId` is never checked at request time. The route guard checks module enablement only
  (`route-guard.ts:281-329`).
- Only 11 built-in tools set `externalContent`. `email.listVisibleMessages`,
  `calendar.listVisibleEvents`, `chat.readAttachment`, `memory.recall` and `people.getContext` carry
  outside content and are unmarked.
- Nothing records that a turn has read outside content. Read-tool calls are not audited
  (`packages/ai/src/gateway/gateway.ts:203`).
- The approval card offers Approve and Reject only, with an email-shaped preview
  (`apps/web/src/chat/action-request-card.tsx:110-121`). Waits live in memory and time out at 150 s.
- The image ships source. `Dockerfile:31` copies the tree and the runtime stage removes nothing, so
  `/app/packages/*/src` is readable at runtime. The repo is public, so source holds nothing secret.

## Design

### Overview

Three new chat tools and one new gateway rule.

| Piece                | Job                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `app.findAction`     | Search the route catalog by plain words; return matching routes with input shape         |
| `app.readSource`     | Read a source file under an allowlisted root, so Moss can learn inputs a schema omits    |
| `app.callAction`     | Call one catalog route as the signed-in user, through the server's own front door        |
| Outside-content rule | A change the user has not trusted asks first once the conversation reads outside content |

Moss's loop: find the action, read the schema or the handler if needed, call it. Server validation
rejects bad guesses with the same error the browser would get, and Moss corrects and retries.

### Route catalog

Built at boot from two sources and joined on method plus path:

- The `onRoute` hook: method, URL, Fastify `schema` (body, querystring, params).
- Module manifests: owning module, `permissionId`, new chat fields below.

Platform-allowlisted routes with no manifest entry are not in the catalog, so they are never
callable.

New optional manifest fields on `ModuleRouteManifest` (`packages/module-sdk/src/index.ts:450`):

```ts
chat?: {
  access: "read" | "write" | "destructive" | "blocked";
  blockedBecause?: SelfOperationExclusionCategory; // required when access is "blocked"
  title?: string; // plain label shown on the approval card; required unless access is "read" or "blocked"
  content?: "user_authored" | "outside"; // every response, including writes; default "outside"
  consent?: string; // AI-consent key; required on every route of a consent-gated module
};
```

A module may set `chatDefaults` at manifest level so it does not repeat the block per route.

Boot assertion, alongside `assertBuiltInSelfOperationManifests`:

- Every declared route resolves to an access class, from its own `chat` block or the module default.
  An unclassified route fails boot.
- `GET` cannot be `write` or `destructive`. `DELETE` cannot be `read` or `write`.
- Every route matching a July exclusion rule is `blocked` with that category.
- Path rules force `blocked`, whatever the manifest says: `/api/admin/*`, `/api/auth/*`,
  onboarding, companion, `/api/mcp`, `/internal/*`, assistant-tool invoke, action-request resolve,
  workflow approval resolve, module queue runs.

This makes parity hold by construction. A new route cannot ship without its author deciding whether
Moss may call it, and the decision costs one field.

### Kept blocked

The seven July exclusion categories carry over unchanged as `blocked` routes. Moss can never raise
its own authority, shape its own prompt, touch secrets or sign-in, widen data consent, change its
own model, or start third-party effects through this path. These cover 32 of the 102 gaps. Ben can
reopen any single item later with its own ruling. This path does not reopen them.

The July spec's rule "no tool may take a preference key as an argument" exists because one generic
set-preference tool could reach YOLO. Route-level blocking replaces that guard for `app.callAction`.
The gateway enforces the class at call time on the resolved route, never on the tool name, so a
blocked route stays blocked however Moss phrases the call.

### Calling a route

`app.callAction` input: `{ method, path, query?, body? }`. Path parameters are filled in the path.

Steps, all inside the gateway:

1. Resolve the route against the catalog. Unknown or `blocked` returns a plain refusal naming the
   reason category.
2. Check AI consent (below), whatever the route class. When consent is off, refuse here. Nothing
   is sent and nothing comes back.
3. Decide run or ask (below).
4. Mint a single-use act-as grant: random 256-bit value, held in process memory, bound to actor
   user id, chat session id and turn id, expiring in 30 s.
5. `fastify.inject` the request with the grant in a dedicated header. The request then passes the
   same route guard, module-enablement check, row-level security and validation as a browser
   request.
6. Return status and body to Moss through the existing 16,000-character rendered-result cap
   (the build plan tightens the original 32 KB sketch). Any response whose route is
   `content: "outside"` uses the outside-content wrapper and admission rule, including a write.

The grant never leaves the process and never reaches a prompt, log, job payload or response. The
plan must name the auth seam that reads it and a test observed failing when the check is removed.

**One grant, one request.** Auth resolves more than once per request today: the module route guard
resolves it (`route-guard.ts:308-327`), then the handler resolves it again (for example
`wellness/routes.ts:260-268`), and the auth wrapper recomputes each time (`auth/index.ts:204-213`).
The first successful resolution consumes the grant and caches the access context on the request
object. Later resolutions in the same request read that cache. A second request carrying the same
grant fails.

Admin power does not pass through. An admin's call is still refused on `/api/admin/*` because the
path rule blocks it.

**AI consent covers every response, not only reads.** A write can return withheld data. For example,
`PATCH /api/wellness/medications/:id` with an empty body passes its schema and returns the full row,
including name, dosage and notes (`wellness/repository.ts:240-270`, `wellness/serialize.ts:29-59`).
So the consent rule keys on the module, not the route class:

- Every route in a module gated on AI consent declares `chat.consent: "<consent key>"`, enforced by
  the boot assertion.
- When that consent is off, `app.callAction` refuses the call at step 2, before inject.
- Approving a change never grants consent. The approval card cannot switch it on, and the consent
  toggle itself is `blocked`.

**Consent on does not widen what a module already promised.** Wellness consent defaults on for
enabled users (`wellness/ai-consent.ts:17-19`), and it covers a narrow scope:

- Medication counts only, never a medication list (`wellness/settings/index.tsx:52-56`, and the
  approved consent spec `2026-06-25-wellness-ai-consent.md:193-197`).
- The assistant never reads therapy notes (`wellness/manifest.ts:296-300`).

So every Wellness route whose response carries a therapy-note body or raw medication details is
`blocked`, read or write, with consent on or off. That covers `GET /api/wellness/therapy-notes`
(`wellness/routes.ts:381-390` returns full bodies) and the medication routes that return the
stored row. Existing Wellness tools keep serving the promised counts. Projecting these routes to a
safe shape, or reaching more Wellness data at all, needs its own consent decision and is out of
scope here. The same rule binds any other module that has made an assistant-facing data promise;
the plan's seams step lists them with `file:line`.

### Run or ask

| Route class   | Conversation clean | Conversation has read outside content |
| ------------- | ------------------ | ------------------------------------- |
| `read`        | runs               | runs                                  |
| `write`       | runs               | asks, unless the user trusted it      |
| `destructive` | asks               | asks                                  |
| `blocked`     | refused            | refused                               |

This matches Ben's 2026-08-19 ruling that installed modules get normal use and only destructive
actions ask. YOLO never overrides the destructive row. Since #3338, YOLO does count as the user's
trust in the outside-content column; see the trust ruling below.

Auto runs share the gateway's existing rate limit (`gateway.ts:171`).

`planCall` (`gateway.ts:345-372`) decides from the tool manifest's `risk` today. `app.callAction`
needs a per-call risk resolved from the route. The plan adds a narrow hook for that one tool rather
than widening the manifest type.

### Outside-content rule

Applies to every write tool, not only `app.callAction`, and to the classifier gate. Ben's rule is
general.

**Taint is set where content enters the model's context, not where a tool is called.** Chat already
pulls content in without any tool call. Passive memory recall, the cross-tool read and notes
retrieval run on each turn and are prepended to the user's text (`engine-text.ts:83-121`,
`154-160`), and launch seeds memory into a new engine (`chat-session-launch.ts:92-119`). So every
path that adds outside content to a prompt goes through an admission boundary that records
metadata before exposure. Prompt blocks use `admitToContext`; gateway surfaces use the shared
content-admission helpers:

| Admission path                                                                  | Taints             |
| ------------------------------------------------------------------------------- | ------------------ |
| Outside/unmarked tool result or `externalContent` result                        | yes                |
| `app.callAction` response from an `outside` route                               | yes                |
| Connected-service tool result                                                   | yes                |
| Attachment read                                                                 | yes                |
| Automatic recall: cross-tool email or calendar read                             | yes                |
| Automatic recall: notes and memory, per turn or at launch                       | yes, when nonempty |
| Unknown/other-owner tool descriptors or exposed remote schema errors            | yes                |
| Listed descriptors from the chat owner's own connection/current approved add-on | no                 |
| Valid, nonempty classifier candidate IDs/labels                                 | yes                |
| Forwarded safe handler errors and nonempty outside progress                     | yes                |
| Module-control text and ordinary/evening seeds                                  | yes, when nonempty |
| Native vault-read reports and nontrivial native permissions                     | yes, before allow  |
| Outside-agent launch and observed allowed read/web/shell asks                   | yes                |
| The user's own typed message                                                    | no                 |
| `app.findAction`, `app.readSource`, app map, settings readouts                  | no                 |

The plan's seams step lists every current admission path with `file:line`. A path that is not
routed through its recording boundary or explicitly classified as no-taint is a blocker. Source
checks cover prompt assembly and named admission sites; they complement behavioral tests rather
than proving the full boundary by themselves.

**Taint belongs to the durable conversation, stored in the database.** Session keys today are actor
plus surface (`chat-surface.ts:18-23`), and the token registry is process memory that a resume
throws away (`session-runtime-helpers.ts:458-496`). Neither can hold this state. Instead:

- A chat-owned row keyed by conversation id records that the conversation is tainted, when and by
  which admission path. Owner-only row-level security.
- Resume, restart and relaunch read the row before the first turn, so a tainted thread stays
  tainted.
- A conversation with no provenance record (every thread from before this ships) counts as tainted.
  Migration `0293` forbids runtime clean INSERT; only the new-thread database trigger initializes
  clean provenance, in the parent insert transaction. Applied migration `0291` remains unchanged.
- Switching threads switches the flag. A clean thread opened after a tainted one stays clean.
- The row is deleted with its conversation. A private chat's row goes with the private purge, so
  this adds nothing that outlives the chat.

Taint lasts for the life of the conversation. A fresh user message does not clean it, because
injected text stays in the model's context across turns. The model cannot clear it.

At the policy decision boundary, a tainted conversation requires approval for writes the user has
not trusted. Native/ACP permission decisions have the explicitly qualified boundary in the current
implementation ruling below.

**Trust ruling (Ben, 2026-10-10, #3338): the user's own trust beats the outside-content mark.**
ACP agents admit outside content at launch, so every ACP chat starts tainted and the strict rule
put an approval card on every write, even under YOLO. In a tainted conversation:

| Write runs because                                                                  | Tainted conversation |
| ----------------------------------------------------------------------------------- | -------------------- |
| YOLO is on                                                                          | runs                 |
| The user promoted its action family (`trusted_auto`, including default tier)        | runs                 |
| A per-call limit the user set (`confirmAbove`, e.g. Finance freedom limit) holds it | asks                 |
| Moss's own rating: classifier `runsWithoutAsking` on a connected tool               | asks                 |
| Moss's own rating: a per-call `app.callAction` write without YOLO                   | asks                 |
| `outbound` risk, any trust                                                          | asks                 |
| `destructive` risk, any trust                                                       | asks                 |
| `confirmWhenTainted` call (e.g. an outbound GET through the app)                    | asks                 |

A trusted write in a tainted conversation dispatches directly. It skips the clean-conversation
claim that automatic runs use, because that claim exists to refuse tainted conversations.
Outbound tools keep the floor because they can carry admitted text out of Moss. The launch taint
itself is unchanged, so native and ACP built-in permissions (file edits, shell, web) still ask in
a tainted conversation.

**Content declarations.** The five originally identified tools were not the complete boundary.
Every built-in read tool now declares `content: "user_authored" | "outside"`, enforced at API boot.
Successful outcomes default to outside unless explicitly trusted; external flags retain outside
handling. Only user-authored responses without those flags are exempt, including write responses
that merely echo the user's own change. Notes and memory remain outside content.

**Scope ruling (Ben, 2026-10-05): strict.** The user's own notes and memory taint like mail,
because a note can hold clipped or forwarded text the user did not write. Automatic recall runs on
most turns, so most changes in a chat will ask. Ben chose this as the starting point; loosening it
(own notes exempt, or an "allow changes for this chat" choice) is a later change if it proves noisy.

Cost: "read my mail and make a task for each" asks once per task. That is accepted for now. Batching
approvals is a later change if it proves noisy.

### Current Slice 7 implementation ruling (2026-10-06)

This section records the implementation of the approved safety rule, not new database or live
verification. The [build plan, section 8.12](../plans/2026-10-05-moss-acts-through-app.md#812-current-slice-7-implementation-ruling-2026-10-06)
contains the complete admission-path inventory, source references and verification limits.

**A clean lookup alone cannot authorize asynchronous dispatch.**
`ConversationProvenancePort.runAutomatic` is implemented by the durable store. In a short
actor-scoped transaction it locks the owned provenance row, requires known-clean state and no
reservation, and inserts a fresh reservation ID. The callback starts only after that transaction
commits and releases its connection. Handler transactions and app-route preflight do not run
inside the claim transaction, so a one-connection pool need not deadlock on nested acquisition.

Content admission locks the same provenance row, then checks reservations in a separate statement
with a fresh READ COMMITTED snapshot. An outstanding reservation rejects admission and withholds
content. Admission that commits first makes a later automatic claim return `confirm` without
running the callback. This is the ordering mechanism; repeated boolean reads are not an atomic
barrier. Automatic result admission occurs after reservation release.

**Native/ACP boundary:** Moss serializes outside-content admission with automatic permission
decisions. It does not serialize or observe the outside engine's eventual operation. A bound
in-flight request can linearize permission decision → admission even if its allow response is
delivered later. This does not claim that every physically executed native write after taint asks.
Terminal native/ACP grant success is deferred until required admission succeeds, so a denied grant
is not reported as successful. These records describe permission, not external-operation completion.

The callback's actual promise must settle before release, which matches the exact thread, owner
and reservation ID. Callback/release failure never becomes a second execution. There is no expiry,
timeout release, cancellation deletion or startup cleanup. An orphan is deliberately fail-closed:
new content is withheld and automatic changes cannot claim clean authority. Wait for an active
action or start a new chat, and check the app before retrying an action that may already have run.
A new chat does not reset the old thread. Ordinary thread/account deletion still cascades.

`0293_chat_automatic_action_reservations.sql` also replaces the old application clean-INSERT
convention with restricted database-trigger initialization on new parent threads. Runtime can
insert known-tainted history, not a clean row for a legacy conversation. No migration backfills
legacy state as clean, and applied `0291_chat_conversation_provenance.sql` is not edited. Both
provenance and reservation tables contain bounded identity/state metadata, not prompts, schema
text, candidate labels, native paths or result content.

**Admission covers inputs before a tool runs as well as its outputs.**

- MCP tool listing and live/shadow classifier menus verify the token's actor before exposing
  descriptors. Only host-stamped, exact-owner connected integrations/current approved add-ons
  bypass descriptor admission; unknown or other-owner tools await `tool_external_descriptors`.
  Remote module labels, classifier descriptions and schemas are covered. Public projections omit
  the ownership stamp; external JSON cannot grant it. Outside results and forwarded errors still require admission.
- Candidate hooks first release their actor-scoped connection. SDK normalization rejects malformed
  or oversize data; valid nonempty ID/label snapshots await `classifier_candidates` admission before
  choice/extraction sees them. Empty/malformed lists create no candidate admission and are not sent
  to argument choice/extraction. Failed admission withholds the snapshot.
- Normal tool schema failures may quote remote field names, so the normal call path admits their
  descriptor text before returning it. A classifier gateway validation failure returns only fixed
  `invalid_input`, without admitting that discarded error text. Other classifier inputs can already
  have tainted the thread. Genuine `HttpError` messages forwarded by `safeErrors` tools use result admission
  even if the tool's successful content is user-authored; fixed generic errors do not expose them.
- Launch memory, default-engine pre-turn recall, notes, cross-tool blocks, module-control text and
  ordinary/evening seeds await admission only when nonempty. Notes and cross-tool privacy checks
  use the captured owner/surface/thread binding. User text, trusted metadata, attachment manifests
  without bytes and bound-thread replay do not create new admissions. The live classifier can
  finish before default-engine retrieval and separately admits its own input surfaces.
- Both Claude vault-read hook variants report before allow; missing tokens or failed reports deny
  the read. The server derives identity from the token and records `native_vault_read`, not file
  contents or body-supplied identity. Other nontrivial native permission allows record
  `native_tool_result` before returning because later output is outside server observation.
- ACP read/web/shell allows record their family paths at every observed allow exit. The ACP engine
  also records `outside_agent_launch` before launch because operations can arrive without a
  permission ask. This conservative fallback is active. Server-side native/ACP reservations cover
  the observed permission/audit callback, not unobservable external-process completion.

**Later owner-descriptor ruling (2026-10-06).** Integration trust uses the immutable connection
owner under owner-only RLS. There is no separately accepted connect-time descriptor baseline:
discovery replaces the current tool snapshot; classifier fingerprints serve review/sort freshness,
not connect-time descriptor acceptance. A baseline/change-detection system is an
explicit follow-up, not part of this change. An owner's refreshed integration descriptors remain
trusted until that follow-up.

Add-ons reuse existing accepted manifest/package hashes and add current approval attribution in 0294. Explicit instance-admin current-hash approval, draft ship or accepted staged installation
establishes the actor; personal enablement, unknown history and an old `enabled_by` do not. The
runtime checks the accepted snapshot and current synthesized descriptors for that exact chat owner.
An add-on approved by an admin remains outside for another user's chat. Legacy installations need
fresh approval; no inferred ownership or historical backfill grants trust. No result, progress,
candidate, forwarded-error or schema-error admission is exempted. ACP launch fallback is unchanged.
See plan section 8.14 for implementation and verification details.

These behaviors have focused unit and guard-removal coverage. At `a77aa4744`, all four integration
shards and all acceptance groups passed; all 25 tracked target suites ran 344/344 with zero skips.
The two unrelated integration skips and existing acceptance fixmes are not passing proof. Docker
is absent locally, so no local database pass is claimed.

Slice 8 uses the supported scripted ACP path with its real outside-context approval, then checks
exactly-once theme change and immediate screen refresh. ACP starts tainted, so this browser case
does not establish clean automatic execution, and a real Codex/ACP read followed by approval does
not establish a clean-to-tainted transition. Those boundaries are explicit in plan section 8.13 and
`docs/3065-app-actions-live-proof.md`. The owner confirmed no sandbox dev access; the
fallback is hosted browser verification plus that checklist, never fabricated live proof. Replacing
the original no-ask browser case is proposed and awaiting Ben; the current ACP-only live runtime
cannot establish clean Run B. The kill gate awaits his ruling, rather than being failed or passed. Real
provider/live-dev results are still outstanding, and Phase 1 remains unverified for completion or
merge.

### Pending memory suggestions (Ben, 2026-10-06)

Kill-gate task 6 ("Accept a suggested memory") failed live. Moss could not find the pending
suggestion, because the only list of suggestions was the memory dashboard, which stays blocked
for retained-content consent. The accept route was a plain `write`, so it would have run without a
card on a clean conversation. Moss saved a duplicate memory instead.

Ben ruled: **Moss in chat may see the user's own pending memory suggestions and accept one, with an
approval card every time it accepts.** No outside-content or taint change is part of this ruling.

- `GET /api/memory/candidates` is a new `read` route. It returns the actor's own pending
  suggestions (owner-only under RLS, newest 50) as display text only: ID, title, summary, record
  kind, provenance and creation time. It never returns episode or source references.
- `POST /api/memory/candidates/:id/accept` is `destructive`, so it always asks, including under
  YOLO. Its target resolver reads the actor's own pending suggestion and puts its full text on
  the card. A suggestion that is not the actor's, or is no longer pending, is refused before any
  card.
- Accept treats a missing request body as empty, so a plain chat call succeeds on its first
  approved card.
- Reject and suppress stay `write` and gain the same target resolver, so their cards name the
  suggestion when they ask.
- A "Remember this" suggestion stores its text as `excerpt`. Titles, summaries and the accepted
  fact now use that excerpt; before, they fell back to "Memory candidate".
- Retained-source recall and the dashboard stay blocked. The new list carries suggestion text
  without a Wellness provenance marker, which the ruling accepts for the user's own suggestions.

### Approval card

The card renders from the record, never from model text, because injected content could make a
model-written summary lie.

- Heading: the route's `chat.title`, for example "Delete custom theme".
- The target, read by the server from the database, never from model text. For example, the name of
  the theme being deleted, looked up from the path id under the user's own access.
- The exact fields being sent, as label and value rows.
- When the conversation is tainted, one line saying Moss read outside content in this chat, so
  changes need approval.
- Approval targets can quote text imported from email, tools or other sources. Displaying a
  resolved card admits that text as outside content before the card is emitted, including a
  changed target on a fresh card; displaying it does not make its instructions authoritative.
- Memory deletion through either `memory.forget` or `app.callAction` shares the exact-version
  snapshot and conditional deletion boundary. Cards show the full memory text, not internal IDs.
  The legacy `DELETE /api/chat/memory/facts/:id` route is blocked from chat because it deletes
  a different store; saved-memory deletion uses `memory.forget` instead. Its UI route is unchanged.
- Other memory approval targets also show plain labels. Their server-only identity snapshots
  retain the exact resolved row IDs/content for approval rechecks, including conflict sets,
  without rendering IDs or hashes. Memory cards omit the technical Path row; the full frozen
  request still binds execution. A structured route target separates `label` from `version`.
- Approve and Reject, as today. A rejection tells Moss the user declined the action, distinct
  from a policy block, cancellation or timeout.

Phase 1 puts the target and fields into the existing card as plain text rows. Two different theme
deletions never show the same card. The redesigned card needs an agreed mockup before phase 2
builds it. The current email-shaped preview stays for the tools that use it.

### Reading source

`app.readSource` input: `{ path, startLine?, endLine? }`.

- Roots: `packages/*/src` and `apps/*/src`, resolved from the running install (`/app` in the image,
  the repo root in dev).
- Extensions: `.ts`, `.tsx`, `.json`, `.md`. Everything else, and any path escaping a root after
  `realpath`, is refused.
- 400 lines per call.
- Read class, never taints. The repo is public and holds no user data.

Moss uses it when `findAction` returns a route with no schema, which is 151 of 236 write routes
today. A later improvement extracts more schemas into the catalog so source reads become rare.

### Screen refresh

Phase 1. After a successful write, the web app refetches that module's queries, the same way existing tools
refresh their screens. The plan cites the current mechanism (`tests/unit/settings-affects-query-keys.test.ts`)
and extends it by module.

### Which path Moss prefers

`findAction` marks a route as covered when a dedicated tool already does the same job, and names that
tool. The dedicated tool keeps its richer summary, undo and preview. `app.callAction` is for
everything else.

## Determinism boundary

- The approval card, refusals and the tainted notice render from records and the catalog, never
  from model output.
- The model has two jobs: pick the route, and fill in its inputs.
- Server validation is the boundary validator for model-authored inputs.
- Prompt guidance for the three tools stays under 150 words.

## Wish-list mapping

| Issue | Effect                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------- |
| #3023 | List, switch, create, edit, delete themes come free. Undo and the contrast warning stay as small follow-ups on #3023.       |
| #3022 | Unchanged. A styling fix that makes custom themes reach quiet text; still a prerequisite for #3023.                         |
| #3025 | Needs the new dismiss route first. Once it exists and is classified, Moss can call it.                                      |
| #3026 | Same: needs the new "handled" route first.                                                                                  |
| #3024 | Separate work. Screen capture is a new consent flow, not a route.                                                           |
| #2998 | The catalog becomes part of self-knowledge by construction: Moss can find every action, not only what the app map declares. |

## Phases

### Phase 1: the path, with the safety rule

- Route catalog, manifest `chat` fields, boot assertion, classification of all 392 routes.
- `app.findAction`, `app.readSource`, `app.callAction`.
- Act-as grant, the auth seam and per-request caching.
- AI-consent check on every response.
- Run-or-ask table.
- Outside-content rule on every write tool and the classifier gate, with taint recorded at every
  admission path and stored on the conversation.
- Mark the five unmarked tools.
- Existing approval card showing the route title, the server-read target and the exact fields.
- Screen refresh by module, so a change shows on screen without a manual reload.

Nothing reaches live user data until every item above lands. Phase 1 ships as one unit.

### Phase 2: the card

- New approval card per the agreed mockup.

### Phase 2 cleanup, 2026-10-07

The resolved-state cleanup implements the four quiet outcomes in the merged approval-card
artifacts: Approved, You declined, Timed out and Cancelled. The outcome replaces the whole
pending card, including its target, field rows, controls and outside-context notice. There is no
separate execution row. Approved records the decision, not successful completion of the action.
The Thinking summary, step count, expansion behavior and expanded list remain unchanged. An
action that fails after approval says "Approved, but it didn’t go through" with a fixed plain
explanation; raw error payloads are not printed in the outcome. New terminal records retain
server-owned action titles and decision identity through streaming and history reload. Older
execution-only history without a decision does not invent an approval outcome.

Automatic writes keep one visible plain outcome too: "Done: <title>" on completion, or
"<title> didn’t go through" with a fixed plain reason on failure. The server captures the title
before dispatch and carries it through unattended result records. An authored action label can
supply a safe fallback when the detailed pending summary contains paths; notes use Create note,
Edit note and Delete note without changing their pending disclosure. Permission grants are never
called Done, and these automatic outcomes never imply the user approved a card. Live and restored
outcomes retain their place before Moss's reply.

Owner-reported live proof on `cf55a711c` preceded the unattended visibility and history-order
follow-up. That earlier proof is not claimed as coverage of these new behaviors.

The outside-content rule already applies to every write through the shared gateway policy on
main. This cleanup adds manifest-driven coverage across shipped built-in and installable writes,
connected-tool origins, ordinary and classifier calls, and clean/tainted controls; it does not
expand the policy. No allow-for-this-chat permission is added.

Pending-card styling and human-field presentation are **not implemented by this cleanup**. The
existing server-read title, full target and exact field disclosure remain. Generic calls still
show technical Method/Path/Query/Body rows while pending: removing these safely needs server-owned
field labels and ID resolution, not filtering or guessing from model text. The mockup fixtures
are not a runtime contract. The pending redesign remains subject to Ben's separate review in
#3090. This cleanup does not claim completion of the earlier before-approval presentation request
or the live-path gate.

### Kill gate after phase 1

Owner: Ben.

On the live dev instance, Moss gets ten tasks it has no dedicated tool for, drawn from the gap list:

1. Switch to a named custom theme
2. Create a custom theme from a name and colours
3. Change the weather unit
4. Add a person in People
5. Mark all notifications read
6. Accept a suggested memory
7. Edit a followed news topic
8. Change meeting preferences
9. Rename a Workshop project
10. Change task preferences

Pass: at least eight succeed with no hand-holding, and every change shows on the real screen
without a manual reload.

Safety proof in the same session:

- A note containing "switch my theme to dark" reaches Moss through automatic recall, with no notes
  tool called. Moss asks before any change, through both the generic path and the dedicated theme
  mode tool.
- The same thread, resumed after a server restart, still asks.
- A delete asks, and its card names the theme being deleted.
- A blocked route (for example run-without-asking) is refused.
- With Wellness AI consent off, a medication write is refused and returns nothing.
- With Wellness AI consent on, asking Moss to read therapy notes is refused.

If fewer than eight succeed, Ben decides whether to keep going or fall back to tools per action.

## Testing

- Boot assertion fails on an unclassified route, a `GET` classed `write`, and an exclusion-matching
  route not classed `blocked`. Each is observed failing with the check removed.
- `app.callAction` refuses blocked and unknown routes, and refuses `/api/admin/*` for an admin.
- Act-as grant: a full guarded request succeeds even though auth resolves twice; a replay of the
  same grant on a separate request fails; an expired grant fails; a request without it from outside
  the process fails.
- Row-level security: a call cannot read or change another user's row.
- AI consent: with consent off, a write route in a consent-gated module is refused and no row data
  returns. Observed failing with the check removed.
- Wellness promises with consent on: therapy-note bodies and raw medication details never reach
  model output, through any read or write route. Observed failing with the block removed.
- Taint at admission: automatic notes recall followed by a write asks, with no notes tool called.
  Launch-time memory seeding taints the same way.
- Taint on dedicated tools: after an outside read, an auto-run tool such as the theme mode tool asks,
  and the classifier gate does not send without asking.
- Taint persistence: a tainted thread stays tainted after resume and after a server restart; a
  thread with no provenance record counts as tainted; switching from a tainted thread to a clean one
  leaves the clean one clean; deleting a private chat deletes its taint row.
- Approval card: two deletes of different themes show different targets.
- `app.readSource` refuses paths escaping a root, symlinks out, and disallowed extensions.
- Live proof: the kill-gate run, recorded on the PR.

## Open questions

| Question                                                                                          | Owner      |
| ------------------------------------------------------------------------------------------------- | ---------- |
| Does `fastify.inject` pass better-auth's trusted-origin and CSRF checks without an Origin header? | plan seams |
| Exact module-level refresh mechanism in the web app                                               | plan seams |
| Where the durable conversation id and private purge live, with `file:line`                        | plan seams |
| Should the July locked items be reopened one by one (persona, skills, memory settings)?           | Ben, later |

## Out of scope

- Admin actions. Admin power is configuration power and stays out of chat.
- New backend actions for #3025 and #3026.
- Screen capture (#3024).
- Undo for `app.callAction` writes.
- An "allow for this chat" option on the approval card.
