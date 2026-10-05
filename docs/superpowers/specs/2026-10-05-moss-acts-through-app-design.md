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
4. `fastify.inject` the request with the grant in a dedicated header. Auth accepts that header only
   when the grant exists in memory, then consumes it. The request then passes the same route guard,
   module-enablement check, row-level security and validation as a browser request.
5. Return status and body to Moss, capped at 32 KB with a truncation note. A read whose route is
   `content: "outside"` returns inside the existing external-content wrapper.

The grant never leaves the process and never reaches a prompt, log, job payload or response. The
plan must name the auth seam that reads it and a test observed failing when the check is removed.

Admin power does not pass through. An admin's call is still refused on `/api/admin/*` because the
path rule blocks it.

Wellness and any module gated on AI consent classify their reads so the route itself refuses when
consent is off, or mark them `blocked`. A route the browser may read is not automatically safe for a
prompt; the class decides.

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

Applies to every write tool, not only `app.callAction`. Ben's rule is general.

- A conversation becomes **tainted** when any tool result enters it that is marked
  `externalContent`, any `app.callAction` read of an `outside` route, any connected-service tool
  result, or any attachment read.
- Taint lasts until the conversation is cleared or a new one starts. A fresh user message does not
  clean it, because injected text stays in the model's context across turns.
- While tainted, every write asks, including tools that normally run automatically and including
  the classifier gate's send-without-asking path.
- The five unmarked tools above gain `externalContent: true`.

State lives with the chat session (`packages/chat/src/session-tokens.ts:150-162` holds the current
turn today). It is server-side, so the model cannot clear it.

Cost: "read my mail and make a task for each" asks once per task. That is accepted for now. Batching
approvals is a later change if it proves noisy.

### Approval card

The card renders from the record, never from model text, because injected content could make a
model-written summary lie.

- Heading: the route's `chat.title`, for example "Delete custom theme".
- Below it: the exact fields being sent, as label and value rows.
- When the conversation is tainted, one line saying Moss read outside content in this chat, so
  changes need approval.
- Approve and Reject, as today.

The current email-shaped preview stays for the tools that use it. This needs an agreed mockup
before phase 2 builds it.

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
- Act-as grant and the auth seam.
- Run-or-ask table, including the outside-content rule for `app.callAction` only.
- Existing approval card with the route title as its summary.

### Phase 2: the rule everywhere, and the card

- Outside-content rule on every write tool and the classifier gate.
- Mark the five unmarked tools.
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

- A note containing "switch my theme to dark" is read, then Moss asks before any change.
- A delete asks.
- A blocked route (for example run-without-asking) is refused.

If fewer than eight succeed, Ben decides whether to keep going or fall back to tools per action.

## Testing

- Boot assertion fails on an unclassified route, a `GET` classed `write`, and an exclusion-matching
  route not classed `blocked`. Each is observed failing with the check removed.
- `app.callAction` refuses blocked and unknown routes, and refuses `/api/admin/*` for an admin.
- Act-as grant: a second use fails, an expired grant fails, a request without it from outside the
  process fails.
- Row-level security: a call cannot read or change another user's row.
- Taint: a write after an outside read asks; a fresh user message does not clear it; clearing the
  conversation does.
- `app.readSource` refuses paths escaping a root, symlinks out, and disallowed extensions.
- Live proof: the kill-gate run, recorded on the PR.

## Open questions

| Question                                                                                          | Owner      |
| ------------------------------------------------------------------------------------------------- | ---------- |
| Does `fastify.inject` pass better-auth's trusted-origin and CSRF checks without an Origin header? | plan seams |
| Exact module-level refresh mechanism in the web app                                               | plan seams |
| Should the July locked items be reopened one by one (persona, skills, memory settings)?           | Ben, later |

## Out of scope

- Admin actions. Admin power is configuration power and stays out of chat.
- New backend actions for #3025 and #3026.
- Screen capture (#3024).
- Undo for `app.callAction` writes.
- An "allow for this chat" option on the approval card.
