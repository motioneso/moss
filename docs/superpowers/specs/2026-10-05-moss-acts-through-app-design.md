# Moss acts through its own app

- **Status:** draft, awaiting Ben's approval
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

Measured at commit 60505036c.

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

| Piece                | Job                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------- |
| `app.findAction`     | Search the route catalog by plain words; return matching routes with input shape      |
| `app.readSource`     | Read a source file under an allowlisted root, so Moss can learn inputs a schema omits |
| `app.callAction`     | Call one catalog route as the signed-in user, through the server's own front door     |
| Outside-content rule | Any change in a conversation that has read outside content asks first                 |

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
  content?: "user_authored" | "outside"; // what a read returns; default "outside"
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
2. Decide run or ask (below).
3. Mint a single-use act-as grant: random 256-bit value, held in process memory, bound to actor
   user id, chat session id and turn id, expiring in 30 s.
4. `fastify.inject` the request with the grant in a dedicated header. The request then passes the
   same route guard, module-enablement check, row-level security and validation as a browser
   request.
5. Apply the AI-consent check to the response (below), whatever the route class.
6. Return status and body to Moss, capped at 32 KB with a truncation note. A read whose route is
   `content: "outside"` returns inside the existing external-content wrapper.

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
- When that consent is off, `app.callAction` refuses the call before inject. Nothing is sent and
  nothing comes back.
- Approving a change never grants consent. The approval card cannot switch it on, and the consent
  toggle itself is `blocked`.

### Run or ask

| Route class   | Conversation clean | Conversation has read outside content |
| ------------- | ------------------ | ------------------------------------- |
| `read`        | runs               | runs                                  |
| `write`       | runs               | asks                                  |
| `destructive` | asks               | asks                                  |
| `blocked`     | refused            | refused                               |

This matches Ben's 2026-08-19 ruling that installed modules get normal use and only destructive
actions ask. YOLO does not override the outside-content column or the destructive row.

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
path that adds content to a prompt goes through one function that records its provenance:

| Admission path                                                 | Taints                       |
| -------------------------------------------------------------- | ---------------------------- |
| Tool result marked `externalContent`                           | yes                          |
| `app.callAction` read of an `outside` route                    | yes                          |
| Connected-service tool result                                  | yes                          |
| Attachment read                                                | yes                          |
| Automatic recall: cross-tool email or calendar read            | yes                          |
| Automatic recall: notes and memory, per turn or at launch      | per Ben's scope ruling below |
| The user's own typed message                                   | no                           |
| `app.findAction`, `app.readSource`, app map, settings readouts | no                           |

The plan's seams step lists every current admission path with `file:line`. A path that is not
routed through the recording function is a blocker. A test confirms this by grepping for prompt
assembly outside that function.

**Taint belongs to the durable conversation, stored in the database.** Session keys today are actor
plus surface (`chat-surface.ts:18-23`), and the token registry is process memory that a resume
throws away (`session-runtime-helpers.ts:458-496`). Neither can hold this state. Instead:

- A chat-owned row keyed by conversation id records that the conversation is tainted, when and by
  which admission path. Owner-only row-level security.
- Resume, restart and relaunch read the row before the first turn, so a tainted thread stays
  tainted.
- A conversation with no provenance record (every thread from before this ships) counts as tainted.
- Switching threads switches the flag. A clean thread opened after a tainted one stays clean.
- The row is deleted with its conversation. A private chat's row goes with the private purge, so
  this adds nothing that outlives the chat.

Taint lasts for the life of the conversation. A fresh user message does not clean it, because
injected text stays in the model's context across turns. The model cannot clear it.

While tainted, every write asks. That includes tools that normally run automatically (for example
`settings.themeMode.set`, `settings/manifest.ts:480-490`) and the classifier gate's
send-without-asking path.

**Unmarked tools.** Five tools carry outside content but lack the mark: `email.listVisibleMessages`,
`calendar.listVisibleEvents`, `chat.readAttachment`, `memory.recall` and `people.getContext`. They
gain `externalContent: true`, subject to the scope ruling for memory and people.

**Scope ruling (Ben).** Automatic notes and memory recall runs on most turns, so treating it as
outside content makes most changes ask. Ben chooses one:

1. Strict. Notes and memory taint like mail. Safest, noisiest. Default until Ben rules.
2. The user's own notes and memory are theirs. Only mail, web, connected services, attachments,
   files and cross-tool email or calendar reads taint.
3. Strict, plus an "allow changes for this chat" choice on the first approval.

Cost: "read my mail and make a task for each" asks once per task. That is accepted for now. Batching
approvals is a later change if it proves noisy.

### Approval card

The card renders from the record, never from model text, because injected content could make a
model-written summary lie.

- Heading: the route's `chat.title`, for example "Delete custom theme".
- The target, read by the server from the database, never from model text. For example, the name of
  the theme being deleted, looked up from the path id under the user's own access.
- The exact fields being sent, as label and value rows.
- When the conversation is tainted, one line saying Moss read outside content in this chat, so
  changes need approval.
- Approve and Reject, as today.

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

After a successful write, the web app refetches that module's queries, the same way existing tools
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

Nothing reaches live user data until every item above lands. Phase 1 ships as one unit.

### Phase 2: the card and refresh

- New approval card per the agreed mockup.
- Screen refresh by module.

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

Pass: at least eight succeed with no hand-holding, and every change lands in the real screen.

Safety proof in the same session:

- A note containing "switch my theme to dark" reaches Moss through automatic recall, with no notes
  tool called. Moss asks before any change, through both the generic path and the dedicated theme
  mode tool.
- The same thread, resumed after a server restart, still asks.
- A delete asks, and its card names the theme being deleted.
- A blocked route (for example run-without-asking) is refused.
- With Wellness AI consent off, a medication write is refused and returns nothing.

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
| Do the user's own notes and memory count as outside content? (scope ruling above)                 | Ben        |
| Where the durable conversation id and private purge live, with `file:line`                        | plan seams |
| Should the July locked items be reopened one by one (persona, skills, memory settings)?           | Ben, later |

## Out of scope

- Admin actions. Admin power is configuration power and stays out of chat.
- New backend actions for #3025 and #3026.
- Screen capture (#3024).
- Undo for `app.callAction` writes.
- An "allow for this chat" option on the approval card.
