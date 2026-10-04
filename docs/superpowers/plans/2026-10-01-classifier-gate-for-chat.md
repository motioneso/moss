# Classifier gate for chat: implementation plan

Date: 2026-10-01. Planning branch: `plan/classifier-gate-for-chat`.
Workspace: `~/Jarv1s/.claude/worktrees/classifier-gate-plan`.

## Status and execution gates

This is a plan only. The task brief records Ben's approval in discussion of
[the spec](../specs/2026-10-01-classifier-gate-for-chat.md), superseding its stale
"Not approved" heading. Its section 5 questions remain open. This planning assignment
explicitly forbids creating an issue, pushing, or opening a PR; it overrides the
plan-build skill's issue prerequisite for this document only. Before product work,
the build coordinator must record the approval and supply a GitHub `task` issue
with its parent link. No issue number is invented here.

Documentation task: update the spec status to "approved by Ben in discussion 2026-10-01, section 5 open" and reconcile spec 3.3/3.4 once Ben rules on candidate privacy.

Use `.claude/skills/plan-build/SKILL.md`. Each numbered task below is one session,
with one bounded deliverable and its own check. Do not combine sessions to fit a
large implementation into one context. Revision 1 moves independent shadow groundwork
earlier and adds Slice 2b before real integration tool menus enter shadow. The
recommended execution order below supersedes the original slice-1-first sequence;
the slice numbers retain the spec backbone. Work orders are revalidated against the
resulting tree, not prewritten implementation. No product code accompanies this plan.

**Release kill gate:** no tool executes through the gate until Ben has set the
shadow agreement rate and review window, reviewed that tool's evidence, and approved
its activation. Missing approval means ineligible, even if the setting says `on`.
A new classifier selection, material tool/schema change or integration preparation/
risk revision requires fresh evidence.
The marker must ship before any real activation. Turning the setting off must restore
today's path immediately for subsequent messages.

Revision 2 (2026-10-03) changes this gate: connected tools are released by Moss's sorting pass
and preparation, module tools by their declaration, and Ben's single shadow review per
classifier selection unlocks On. See "Revision 2" below.

## Revision 2 (2026-10-03): connected tools on by default (#2984)

Ben ruled on 2026-10-03 that per-tool review is too much work for users. The spec's section 8 holds
the rulings and the design. This revision lists what it supersedes in this plan and the build slices
that replace it. Where this section and an older task disagree, this section wins.

### What this supersedes

| Plan item                        | Status after revision 2                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2b intro: switches default off   | Connection switch stays default off. Tools are on by default; "kept out" replaces per-tool opt-in.                                                                       |
| 2b.1 mockups, risk review editor | Superseded by `docs/superpowers/mockups/integrations-redesign/` (PR 2985).                                                                                               |
| Risk options table, ruling 5     | Superseded. The sorting pass and a code rule set risk (spec 8.2); hints only raise it.                                                                                   |
| 2b.2 opt-in and reviewed risk    | Storage stays. Meaning changes: on unless kept out; risk from the sort. Stale entries re-sort and re-prepare by themselves.                                              |
| 2b.3 preparation, ruling 6       | The draft logic stays. It runs as a background job when the connection's switch turns on, saves validated output with no review, and gains the credential check (R2.4).  |
| 2b.4 review editor               | Removed from the screen by R2.5.                                                                                                                                         |
| 2b.6 screen proof                | Replaced by R2.6.                                                                                                                                                        |
| 1.2 On precondition              | "At least one approved release row" becomes "the admin shadow-review record for the current classifier selection" (R2.4).                                                |
| 4.2 release eligibility          | Per-tool admin approval is retired. Connected tools are released by sort and preparation; module tools by declaration; Ben's single shadow review unlocks On (spec 8.5). |
| Ordinary policy, "out of scope"  | Narrowed. Look-up and change tools run; sending asks unless the owner allows it; Sensitive, unsorted and stale ones ask; YOLO unchanged (spec 8.3, R2.3).                |

Unchanged: the gate engine, shadow records and their retention, the activity log, the gateway's
no-card path, candidate lists and the reply contract (2b.5), the handled-turn lifecycle (4.1), and
the live activation proof (4.3).

### Slices, in build order

Each slice is one session with its own PR, app-map and manifest updates in the same PR, and the
verify-gate skill for any database test. R2.1 to R2.3 change no screen. R2.4 needs R2.1 and R2.2,
and starts only after PR 2976 (activity history) merges, because both edit the gate's wiring files.
R2.3 needs R2.1 and R2.2. R2.5 needs R2.1 to R2.4. R2.6 needs all of them.

**R2.1 Sort storage, risk inputs, readable names and the old-entry conversion (one backend
session).** Own `packages/integrations/src/classifier-settings.ts`, the repository, a new
`classifier-risk-inputs.ts` and a new migration under `packages/integrations/sql/`. Add the per-tool
sort record (group, readable name, sort fingerprint, sort status of current, failed or never tried,
sorted time), the "kept out" flag and the send-without-asking flag to the owner's connection row.
The send flag is tied to the sort fingerprint and cleared when the sort goes stale. Define the risk-inputs record:
the fields the definition fingerprint covers plus the HTTP method from the tool's call recipe. The
sort fingerprint hashes that record; the definition fingerprint stays as it is for preparation. Add
the free rule that makes a readable name from a raw name. Convert old entries once (spec 8.7). No
model call yet.

- Proves: two owners and an admin cannot read each other's sort records; an operation that changes
  from `PUT` to `DELETE` with the same operationId, summary and schema changes the sort fingerprint,
  seen failing with the method left out of the record; the free rule names Home Assistant and
  web-service tools sensibly; an old entry with opt-in off becomes kept out; an old reviewed risk
  survives only when higher; existing connections convert with every tool never tried.

**R2.2 The sorting pass (one AI and integrations session).** Own a new
`packages/integrations/src/classifier-sorting.ts`, its job wiring and the composition port that
already selects the default chat model for preparation. One batched, bounded call per change sends
only names, descriptions, group labels and the reduced input schema (spec 8.2). Run the credential
check before every call; a hit leaves the tool unsorted with "Could not sort safely". Apply the code
risk rule, which takes only the risk-inputs record. Validate names. Run on connection add and on
changed discovery, with the classifier on or off. Add the existing-connection path: a one-time
check at worker start enqueues one job per connection with never-tried tools, keyed to run once,
and discovery and the switch also enqueue never-tried tools. A failure marks tools failed and shows
"Try again"; no path retries a failed tool by itself. Correct every copy of the overstated secrecy
claim: the preparation disclosure text in `packages/shared/src/integrations-api.ts` and the comment
on the payload builder in `packages/integrations/src/classifier-preparation.ts`.

- Proves, each seen failing with its protection removed: a synthetic secret placed in a `const`,
  `enum`, `default`, `example`, `pattern`, `title` or vendor key never reaches the prompt; a tool
  whose description or property description holds the stored credential, plain, base64 or
  URL-encoded, is not sent and asks; the prompt holds no address, header or sign-in detail.
- Also proves: an existing connection with unchanged tools and no sort becomes sorted without
  reconnecting or editing a tool; the one-time job runs once per connection; a failed tool is not
  retried by discovery, the switch or the one-time job; one call per changed tool and none for an
  unchanged one; a `PUT` to `DELETE` change re-sorts the tool to Sensitive; a read-only hint never
  lowers a group; a destructive hint or `DELETE` method raises it; a skipped or invalid tool becomes
  Sensitive; a hostile description cannot change another tool's group or name; job payloads carry
  IDs only and never the matched credential.

**R2.3 Safe tools run, risky tools ask (one gateway and integrations session).** Own the classifier
metadata in `packages/integrations/src/tool-manifests.ts`, the eligibility read in
`classifier-settings.ts`, and `packages/ai/src/gateway/policy.ts`. Carry the gateway change in spec
8.3. The integrations module marks a connected tool's synthetic manifest sorted safe only when the
owner's sort fingerprint matches the tool's current risk inputs and its group is Looks things up,
Changes things, or Sends things out with the send-without-asking flag. Add the owner-only requests
that set and clear that flag, per tool and for every tool in the group. The gateway's ordinary
policy runs an external tool with that mark unless a confirmation override applies; the check sits after the
destructive check and before the outbound check. The sorted group also replaces the owner-reviewed
risk as the gate's risk, including the empty-success reply fallback that 3.5 noted still keys off
the server's read-only hint. Expose whether a tool asks first for the page. Manifest risk and
execution policy stay as they are. The PR carries a user-facing release note, because ordinary chat
changes with the classifier off.

- Proves, each seen failing with its guard removed: a safe connected tool runs with no card with
  YOLO off; a Sensitive, unsorted, failed-sort or stale tool asks; an unreadable sort record asks; a
  first-party outbound tool still asks; a confirmation override still asks; another owner's sort
  never marks a tool safe; a tool whose method changed from `PUT` to `DELETE` after its safe sort
  asks at the next call; a Sends things out tool asks until allowed and runs after; the flag on a
  Sensitive tool is ignored; another owner or an admin cannot set the flag.
- Also proves: each group gets its bar, and a Sensitive tool below 0.98 is refused; the gate runs a
  safe connected tool outside YOLO and declines a Sensitive one with zero handler calls; YOLO
  routing is byte-identical before and after.

**R2.4 Automatic preparation and the release record (one backend session).** Own the prepare route
and a background job in `packages/integrations/src/`, `packages/chat/src/live/classifier-gate-wiring.ts`,
the settings On check in `packages/settings/src/runtime-config-routes.ts`, and a new chat migration
for the admin shadow-review record. Turning the connection's switch on prepares every sorted tool
that is on, saving validated output directly. Preparation runs the same credential check as
sorting before each call. A changed tool re-prepares by itself. The gate's
release check reads connected-tool eligibility (spec 8.5) and module declarations, not the per-tool
admin table. On needs the shadow-review record for the current classifier selection, checked when
read. The per-tool table stops being read; its drop is a later migration.
Start only after PR 2976 (activity history) merges; it edits the same gate wiring files.

- Proves: eligibility drops when a tool is kept out, switched off, changed or unsorted, and returns
  after automatic re-preparation; a forged request cannot set On without the review record; a
  changed classifier selection drops a stored On to shadow at read time; one owner's preparation
  never releases another owner's tool; preparation job payloads carry IDs only; preparation runs
  the same credential check as sorting, seen failing with the check removed.

**R2.5 The connection's page (one UI session).** Use the design-system skill. Own
`apps/web/src/settings/settings-integrations-pane.tsx` and focused new components. Build the
pieces in spec 8.6 from the integrations-redesign mockups: full width with "Back to connections",
readable and raw names, groups, "Asks first" with its YOLO line, "Keep out of the classifier",
the classifier rail and its states with the "always ask" count, and the sorting line. Add the
send-without-asking controls of spec 8.3: "Send without asking" and "Ask before sending" in a
Sends things out tool's menu, and "Send all without asking" with its inline confirm and "Ask first
for all" in that group's header. First add them to the integrations-redesign mockups and get Ben's
sign-off on the picture. Remove the per-tool review editor.

- Proves: unit tests for each classifier state, keep-out, the sorting line, and allowing and undoing
  sending per tool and per group; design token and
  class checks; desktop 1440x900 and phone 390x844 screenshots with no crowded text; app map
  matches the screen.

**R2.6 Live proof on the real screen (one test session).** Replace 2b.6's prepare-edit-approve path
with a real connection on a dev instance, through the real screen, with no faked responses. A
stand-in tool server is allowed for the claim about what Moss sends, disclosed on the PR.

- Proves: a new connection's tools all start on with no review; a connection made before the
  upgrade gets sorted with no reconnect; sorting runs with the classifier
  off and its call count matches the changed tools; the sorting line shows; turning the classifier
  on prepares with no further clicks; with YOLO off a safe tool runs with no card and a Sensitive
  tool shows "Asks first" and asks; a Sends things out tool asks, runs once allowed from the group
  header, and asks again after "Ask first for all"; YOLO handles a Sensitive tool only above its bar; a kept-out
  tool stays usable in ordinary chat and never appears in shadow records; shadow records appear for released tools.

After R2.6, 4.2 is Ben's one shadow review per classifier selection, then 4.3 as written.

### Rulings added by revision 2

17. **Connected tools on by default (Ben, 2026-10-03).** No per-tool review, no Prepare button, no
    per-tool risk choice. Every tool starts on and the user only switches tools off. Supersedes
    ruling 5 and the review half of ruling 6.
18. **Sorting pass.** One cheap default-model pass sorts each tool by what it does, even with the
    classifier off. It also writes the readable name.
19. **Risky tools start on and still ask.** Sensitive tools show "Asks first" and ask before every
    run outside YOLO (rulings 25 and 26 cover the other groups). YOLO mode, off by default and
    admin-only, skips the asking under decisions D1 and D2 of `docs/superpowers/specs/2026-06-29-admin-yolo-auto-approval-mode.md` (spec 8.3).
20. **Keep out of the classifier** in a tool's menu; ordinary chat is unaffected.
21. **The name stays "Classifier".**
22. **No sorting notice.** A line on the connection's page says what is sent and who reads it.
23. **Full-width connection page** with "Back to connections".

24. **One shadow review per classifier (Ben, 2026-10-04).** One look at the practice report per
    classifier selection unlocks On. No per-tool sign-off (spec 8.10).
25. **Look-up and change tools run without asking (Ben, 2026-10-04).** Outside YOLO, tools sorted
    Looks things up or Changes things run without a card; Sensitive, unsorted, failed-sort and
    stale tools ask. Needs the gateway change carried by R2.3 (spec 8.3).
26. **Sending asks first unless allowed (Ben, 2026-10-04).** Sends things out tools ask first by
    default. The owner can allow sending without asking per tool or for the whole group, and undo
    it with one click. Sensitive always asks outside YOLO. R2.3 carries the rule and R2.5 the
    controls (spec 8.3).

No questions from revision 2 remain open.

## Seams check and rulings ledger

Checked the current worktree with codebase-memory graph search, call tracing and
source reads before choosing boundaries. Graph coverage excludes parts of external
module loading, so bounded source searches filled those gaps. Agent memory returned
no matching prior classifier/platform-seam observations. The archived classifier
discussion in the Obsidian vault preserves the four unresolved decisions, not answers
to them. Citations below are from the planning checkout; recheck them at build start.

| Capability                                  | Current evidence                                                                                                                                                                                                                                                                                | Consequence for the plan                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted chat input                         | `packages/chat/src/live-routes.ts:127` validates the request; attachment lookup completes before `submitTurn` at line 178.                                                                                                                                                                      | Gate sees the accepted original text and resolved attachment metadata, not an independently parsed copy.                                                                                                                             |
| Shared turn boundary                        | `packages/chat/src/live/chat-session-manager.ts:302` takes the actor/surface turn lock and calls `runTurn` at line 327. `runTurn` installs cancellation and activity state at line 366, calls `ensureSession` at line 395, builds retrieval-enriched text at line 411, and submits at line 442. | Put the gate inside that lock, after cancellation/activity setup and before `ensureSession`. A handled message must never reach session creation, retrieval, or model submission.                                                    |
| Session launch itself can submit            | `packages/chat/src/live/chat-session-manager.ts:214` launches the engine; line 261 submits replay on one runtime path.                                                                                                                                                                          | A hook immediately before line 442 is too late. The earlier boundary is necessary even for a cold session.                                                                                                                           |
| Other entry paths                           | `packages/chat/src/live-routes.ts:418` also uses `submitTurn`; `chat-session-manager.ts:333` separately seeds context.                                                                                                                                                                          | Apply the gate to accepted user turns across surfaces. Do not treat internal context seeding as a user command. Preserve surface/control context on fallback.                                                                        |
| Classifier setting                          | `apps/web/src/settings/settings-ai-sorting-row.tsx:43` saves/deletes the reserved binding; `packages/shared/src/ai-types.ts:142` defines its key. `packages/ai/src/capability-route-routes.ts:89` reads it and line 114 admin-gates writes.                                                     | Rename public copy to Classifier without migrating the existing `sorting` storage key or breaking background consumers. Gate-state ownership is a separate unresolved decision.                                                      |
| Classifier routing                          | `packages/ai/src/repository.ts:1425` resolves the sorting model; line 1452 reads its binding and honors explicit-binding/admin-pin restrictions.                                                                                                                                                | Resolve the configured classifier inside the AI boundary, preserving existing routing restrictions. No classifier means decline; never borrow the chat default to classify.                                                          |
| Choice transport                            | `packages/ai/src/structured/generate-choices.ts:15` includes confidence and probabilities; line 75 exposes `generateChoices`; line 174 accepts an explicit resolved model.                                                                                                                      | Reuse this transport behind a capability-based router. It is not itself a universal classifier router.                                                                                                                               |
| Existing wrapper is insufficient            | `packages/ai/src/structured/ask-sorting-questions.ts:127` resolves the setting, line 211 calls `generateChoices`, line 228 drops probabilities, and line 86 defines a yes/no-only structured schema.                                                                                            | Preserve existing consumers; add the small generic choice/typed-argument contract in the AI package. Do not pretend this helper already supports tool selection and runner-up scores.                                                |
| Structured calls retry today                | `packages/ai/src/structured/generate-structured.ts:119` accepts an explicit model and line 219 applies repair retries. Its sorting fallback begins at line 173.                                                                                                                                 | Add an explicit single-attempt option for gate calls. Use the resolved classifier and caller deadline; disable repair retries and internal default-model fallback.                                                                   |
| Gateway composition                         | `packages/chat/src/routes.ts:289` constructs tokens and the gateway; line 327 constructs the runtime; line 349 captures an executable-tool allowlist when minting.                                                                                                                              | Inject the gate from this composition root, through `packages/chat/src/live/runtime.ts` and the manager ports. Do not create a second gateway or import another module's internals.                                                  |
| Existing authority path                     | `packages/ai/src/gateway/gateway.ts:185` verifies token identity, checks executable tools and allowlist, validates input, and resolves confirmation/policy. Lines 236, 291 and 336 cover YOLO, ordinary policy and confirmation.                                                                | Gate execution must call this same path. It needs a decline-without-card option and a side-effect-free shadow evaluation; neither exists today.                                                                                      |
| Rate limiting and confirmation              | `gateway.ts:248` consumes YOLO allowance; line 297 consumes ordinary allowance and line 306 may create a card.                                                                                                                                                                                  | A separate preflight in chat would race and duplicate policy. Keep decisions in the gateway; intercept every confirmation branch, including rate-limit escalation. Shadow must not consume allowance.                                |
| Handler result and identity                 | `gateway.ts:645` executes then sanitizes; line 655 detects module-reported failure even though the public response at line 658 is `ok: true`. `gateway.ts:732` dispatches under `withDataContext`.                                                                                              | Preserve actor-scoped dispatch and audit. Expose a trustworthy execution outcome to the gate; public `ok` alone is insufficient to choose success/fallback. This is a seam observation, not a new end-to-end security certification. |
| Engine-independent token                    | `packages/ai/src/gateway/session-tokens.ts:91` mints from a supplied session identity without launching an engine.                                                                                                                                                                              | Mint a short-lived gate token with actor, surface session and captured tool allowlist. Revoke that token alone in `finally`; do not revoke an existing model session's tokens.                                                       |
| Tool declarations                           | `packages/module-sdk/src/index.ts:575` defines `ModuleAssistantToolManifest`, including schemas, risk, family and confirmation hooks.                                                                                                                                                           | Add optional classifier metadata here; absent means off. Module ID remains the area; no new grouping hierarchy.                                                                                                                      |
| External declarations are a separate path   | `packages/module-sdk/src/external-module.ts:179`, `packages/module-registry/src/external/validate.ts:634`, and `packages/module-registry/src/external/tool-manifests.ts:52` define, validate, and explicitly copy external tool fields.                                                         | Update all three, plus the runtime dispatch contract for candidate hooks. Adding only the built-in interface silently loses external opt-in.                                                                                         |
| Input validation is incomplete for this use | `packages/ai/src/gateway/input-validation.ts:19` supports a subset of schema keywords; `packages/ai/src/structured/generate-structured.ts:282` already uses schema validation.                                                                                                                  | Gate boundary must validate the full eligible schema, candidate membership, bounds and unknown fields. Reuse installed validation machinery with external-schema resource limits; do not rely only on the gateway's subset.          |
| Normal persistence assumes a model ran      | `packages/chat/src/live/persistence.ts:248` requires an executed provider/model; `packages/chat/src/repository.ts:220` writes it to message metadata at line 269.                                                                                                                               | Add a discriminated gate completion origin; never fabricate model execution metadata. Reuse completed-turn storage and normal transcript delivery.                                                                                   |
| Private chat and sharing                    | `packages/chat/src/live/persistence.ts:280` skips persistence for incognito; `packages/chat/sql/0025_chat_owner_or_share.sql:51` permits shared message reads.                                                                                                                                  | Shadow records need a separate owner-only table, not inherited message sharing. Preserve private-chat non-persistence; resolve its shadow-review treatment before collection.                                                        |
| Existing reply surfaces                     | `apps/web/src/chat/message-row.tsx:128` and `packages/ui/src/chat-thread.tsx:242` render reply footers; `apps/web/src/chat/chat-drawer.tsx:308` merges the HTTP result.                                                                                                                         | Carry origin through HTTP, SSE, history and shared thread rendering. A marker in only one component is incomplete.                                                                                                                   |
| App map and design gates                    | `packages/shared/src/app-map-core.ts:253` describes the sorting row. `docs/DEVELOPMENT_STANDARDS.md:148` and `docs/design-system.md:145` specify guardrails and shared primitives.                                                                                                              | Update map and owning manifests in each product slice. Both new UI surfaces require Ben's mockup review before implementation.                                                                                                       |

Keep this ledger, including limitations and rejected options, through future review
rounds. Append new tree facts with citations and decisions with their owner; do not
remove a finding merely because a later slice fixes it.

### Revision 1 ledger additions (2026-10-01)

The original ledger above is retained. These additions correct its missing coverage
of user-connected tools; they do not turn those tools into first-party modules.

| Finding or ruling                                     | Evidence                                                                                                                                                                                                                                            | Planning consequence                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections already form classifier areas             | `packages/integrations/src/discovery.ts:15` dispatches discovery; `mcp-client.ts:41` maps name, description, schema and annotations; `tool-manifests.ts:281` builds one synthetic module per connection.                                            | Reuse the synthetic module as the area, shown as the connection name. Store configuration against owner/connection ID/tool name, not a mutable slug. Reject ambiguous slug/tool collisions in the gate until unambiguous; do not rename ordinary-chat tools in this slice. |
| Discovery hints are not risk authority                | `packages/integrations/src/mcp-client.ts:48` reads `readOnlyHint` into `readOnly`; `tool-manifests.ts:272` hard-codes `outbound` and `auto` for all discovered tools. Line 174 uses the hint for the envelope action, not manifest risk.            | A server's hint is untrusted evidence only. Add reviewed classifier risk, unknown by default, without rewriting ordinary gateway risk.                                                                                                                                     |
| Ordinary and YOLO approval differ for external tools  | `packages/ai/src/gateway/policy.ts:38` confirms outbound in normal mode; line 74 permits external tools in the YOLO family check. `gateway.ts:238` still honors per-call confirmation overrides.                                                    | The earlier general description of family trust is incomplete for integrations. Preserve this existing exception and the normal confirmation path. Classifier unknown-risk exclusion applies even in YOLO. Connection opt-in never grants gateway authority.               |
| Discovery staleness currently survives refresh errors | `packages/integrations/src/repository.ts:203` saves discovery; its null-tools branch preserves the previous list. `routes.ts:188` refreshes and line 219 drops the resolver cache. `resolver-cache.ts:23` caches for 30 seconds.                    | New classifier eligibility must be invalidated on changed discovery, failure, or expired freshness; it cannot inherit stale ordinary-chat availability. Check stored approval versions again at dispatch.                                                                  |
| Owner storage exists                                  | `packages/integrations/sql/0207_integration_connections.sql:24` enables/forces RLS and line 27 scopes access to the actor.                                                                                                                          | Store preparation and switches with owner-scoped connections; add a new module migration and extend isolation tests, not an admin review bypass.                                                                                                                           |
| Code-authored result summaries exist                  | `packages/integrations/src/tool-manifests.ts:242` constructs status/action/summary/detail using `INTEGRATION_SUMMARY`; `summaries.ts:2` defines the strings. `gateway/output-validation.ts:53` returns unschematized data unchanged.                | Read only the validated envelope fields needed for replies; never dump arbitrary detail into a template. Empty summaries need explicit fixed fallbacks.                                                                                                                    |
| Setup must use the actual chat selection              | `packages/chat/src/live/persistence.ts:165` resolves through `AiRepository.selectChatModelForUser`.                                                                                                                                                 | Inject the same selection through the AI composition boundary for setup. Do not use the Classifier binding or a generic structured default, and do not launch a user chat turn to prepare tools.                                                                           |
| Existing UI and app-map surfaces                      | `apps/web/src/settings/settings-integrations-pane.tsx:153` renders connection detail and line 376 grouped tools; `packages/shared/src/app-map-core.ts:171` declares integrations; `packages/integrations/src/manifest.ts:35` owns feature metadata. | Extend these surfaces and declarations in Slice 2b, with mockup approval and live proof.                                                                                                                                                                                   |
| Revision scope and ordering                           | Ben's revision-1 brief requests user-connected integrations early, parallel shadow groundwork, and no change to ordinary approval behavior.                                                                                                         | The missing-first-party-module observation remains true; its former module-identification blocker is superseded by Slice 2b.                                                                                                                                               |

### Boundary choices

Use the manager boundary rather than the HTTP route: the route is simpler for one
endpoint, but misses other callers and would run outside the shared turn lock.
Use a gateway option rather than a chat policy precheck: a precheck would be small,
but could create cards or execute under changed trust after checking. Reuse existing
AI transports rather than calling `generateChoices` directly from chat: direct use
preserves scores, but does not cover structured-capable selections or no-retry behavior.
No separate policy service, provider client, grouping taxonomy, or workflow engine.

These are local seam choices, not a new platform architecture. This planning session
uses no delegated agents. Product reviewers must review the actual wiring and the
policy-negative tests, not accept this document as proof of implementation.

## Contracts and invariants to build

- The classifier has exactly two jobs: (1) choose an eligible module area or a decline
  sentinel; (2) choose one eligible tool and its validated argument values, or decline.
  Stage two may carry named argument-choice questions in the same request. If a safe
  bounded schema cannot express the choice and its arguments within that stage, the
  tool is ineligible; do not hide extra model rounds. Typed extraction is capability
  dependent. No names of providers or models determine gate behavior. Setup preparation in 2b
  is a separate, user-reviewed default-model job; no preparation model runs per message.
- Resolve the Classifier binding once per attempt. The AI router reports supported
  answer capabilities and returns scores in a common contract. The user's configured
  default chat model is reached only by resuming the existing chat path, unchanged.
- The gate gets only the accepted message and bounded menu descriptions/candidate
  labels needed for that decision. No history, retrieval, memory, credentials or raw
  tool results go into classification. Candidate lists containing stored user data
  create a spec ambiguity explicitly listed below; do not silently broaden disclosure.
- Before model work: decline attachments, UTF-8 length over 2,000 bytes, missing
  classifier, off state, cooldown, or no eligible tools. `none` and
  `needs_earlier_conversation` decline. A module-controlled/context-dependent request
  must not be acted on using context the classifier is forbidden to see.
- One 3,000 ms deadline covers both stages, including preparation within the attempt;
  pass remaining time and cancellation through both transports. No retries. Timeout,
  provider error or malformed answer declines and starts a 30-second cooldown scoped
  to the affected actor/classifier. User cancellation stops the turn, not a fallback
  model turn. Late results cannot trigger a tool. Bound candidate and policy reads so
  a stalled dependency cannot strand chat.
- Validate tool membership, every argument and candidate identity before dispatch.
  Use stable candidate IDs; labels are untrusted data, not instructions. Reject unknown
  fields, missing required values, non-finite numbers, malformed scores, and unsupported
  schemas. Never send the raw message as tool input.
- Apply the eventual tool's risk bar (reviewed classifier risk for integrations,
  subject to Ben's 2b ruling) to both stages and argument answers: initially
  read 0.90, write 0.95, outbound/destructive 0.98, with a top-minus-runner-up lead of
  at least 0.40 for each choice. These are provisional shadow thresholds, not proven
  accuracy. Missing runner-up evidence means decline, not invented certainty.
- Distinguish `declined-before-execution`, `executed-success`, and
  `executed-failure-or-unknown`. Only a failed read may fall back after dispatch.
  A failed/unknown write/outbound/destructive attempt, a timeout or module-reported
  error after its dispatch, or failed reply rendering after a mutating dispatch
  produces a code-written terminal outcome; never replay the
  message to the default model. The specific rule in spec 3.8 takes precedence over
  the broad "every failure" wording in 3.9.
- Templates render from validated/sanitized tool results and execution records, never
  model prose. All UI acknowledgements, errors, and the marker derive from records.
  Host chat owns message persistence and delivery; modules never inject chat turns.
  Guidance stays below 150 words and includes an untrusted-data contract and worked
  example. Model-authored user-data values require schema descriptions, that contract,
  and boundary validation. For this task, the approved spec's explicit unattended
  typed-argument path and no-gate-card rule override plan-build's generic per-item
  before/after acceptance rule. Existing gateway confirmation still wins: decline
  whenever it would require acceptance. Do not add a new approval flow.
- Shadow does not execute tools, create approval cards, consume auto-run allowance, or
  delay the default turn waiting for classifier completion. It records a hypothetical
  decision and correlates the first actual model tool attempt by turn ID. Keep `none`,
  pending, cancelled, failed, and unobserved outcomes distinct from a mismatch. Compare
  normalized module/tool identity; record argument agreement separately when safely
  available. Tool-name agreement alone does not certify argument safety.

## Candidate inventory: first-party and user-connected tools (not an activation decision)

| Requested use                  | Exact current candidate                                                                                                                       | Work and eligibility before opt-in                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a task                     | `tasks.create`, `packages/tasks/src/manifest.ts:638`; handler `packages/tasks/src/tools.ts:188`; input `packages/shared/src/tasks-api.ts:379` | Requires a typed title; choice-only classifiers cannot supply it. Restrict the gate's offered argument subset; validate against the real schema. Render from the returned task record. Existing gateway trust and confirmation still apply.                                           |
| Today's calendar               | `calendar.listVisibleEvents`, `packages/calendar/src/manifest.ts:306`; handler `packages/calendar/src/tools.ts:146`                           | Derive today's start/end from the actor's timezone in code; defaults are not "today". A bounded template must handle no events, gaps/stale results and overflow truthfully. Long/open-ended results decline.                                                                          |
| Smart-home switches and scenes | Expected through a user-connected MCP integration, including Home Assistant; no first-party tool declaration is required.                     | Slice 2b prepares the discovered tool menu with user opt-in. Exact server tool names and schemas come from discovery. Choice-only classifiers need real device/area candidates for free-text name inputs; typed-capable classifiers can extract those names without a candidate list. |
| Timers                         | Expected through user-connected integrations when the server exposes timer tools; runtime idle-reap timers are unrelated.                     | Slice 2b supplies preparation, risk review and opt-in. Do not invent a first-party timer module or assume every connected server exposes timers.                                                                                                                                      |

The two first-party tools are the available shortlist for Ben's section 5 decision,
not permission to opt in both. Integration tools use the separate user opt-in in 2b.
Third-party/integration tools are not automatically
eligible merely because they are installed or have an input schema.

## Recommended execution order (revision 1)

Start with evidence-producing backend groundwork, not a rename-only release. This
is a scheduling recommendation for future build sessions, not an instruction to
spawn agents in this documentation task. Keep one session per numbered unit.

1. Start 3.1 (AI routing), 3.2 (gateway), and 3.4 (shadow storage) against fixtures
   while the UI owner reviews 1.1 and 2b.1 with Ben and the SDK owner does 2.1.
   These have separate code ownership. The unanswered setting scope does not block
   a decision engine tested with injected off/shadow state. No real-message shadow
   collection starts until the privacy/state decisions and production wiring land.
2. After the SDK contract settles, start 3.3 against synthetic tool menus. In
   parallel, do 2b.2-2b.3 setup/storage work after their decisions clear. The AI
   owner lands 3.1 before 2b.3 touches shared AI exports/routing. External-module
   support in 2.2 and first-party 2.3 need not hold up the user-connected pilot.
3. Land 1.2-1.3 and 2b.4 after mockup approval. 2b.5 needs the gateway work in 3.2
   and the reviewed preparation contract. Complete 2b.6 before 3.5 uses real
   integration tool menus. Then wire 3.5 and collect shadow evidence immediately;
   do not wait for unrelated first-party or external-module opt-ins.
4. Prepare 4.1 while shadow evidence accumulates; review/build 5.1-5.2. Complete
   4.2 with Ben's rate/window decision before 4.3. No real tool execution precedes
   the kill gate, marker, candidate-specific decisions and live-path proof.

One integration owner serializes edits to `tool-manifests.ts`, repository/routes,
and the integrations UI; one chat owner serializes manager/runtime/persistence.
The shared map and each manifest have one merge owner at a time: queue their small
same-slice edits rather than concurrently editing those files. Each product slice
still carries its own truthful map declarations in its PR. Parallel groundwork
may use fixtures; it may not bypass an undecided privacy or mockup dependency.

## Slice 1: rename and setting

### 1.1 Settings mockup review (one design session)

Owner: UI implementer, reviewed by Ben. Use `.claude/skills/design-system/SKILL.md`,
`docs/design-system.md`, and `packages/ui/OPTIONS.md`. Produce a settings-row mockup
in the design spec using existing `Field`, `Select`/`Segmented`, and help/status
primitives. Include no classifier, unavailable selection, loading, save failure,
read-only permissions, off/shadow/on, and `on` unavailable pending release approval.
Show the API disclosure: eligible chat messages are also sent to the chosen classifier
provider, in addition to the default provider in shadow/fallback cases. Do not imply
quickly declined attachments are uploaded to it. Preserve existing background-use
privacy disclosures while renaming. Capture Ben's agreement before tasks 1.2-1.3.

Exit: agreed mockup and gate-state scope decision recorded in the spec. No UI code.

### 1.2 Setting contract and storage (one backend session)

Depends on 1.1 and Ben's state-scope choice. Touch `packages/shared/src/chat-api.ts`,
`packages/chat/src/manifest.ts`, the owning settings API/repository selected by that
choice, and a new owning-module migration only if needed. Define off/shadow/on with
off as the missing-value default. Preserve the admin-owned Classifier binding and
its storage key. Per-user state must use actor preferences; admin-wide state must
use the existing admin configuration boundary, not a new admin private-data bypass.
Reject live activation without an approved tool release record; no bypass from a
forged API request. This slice changes no chat execution.

Update `packages/shared/src/app-map-core.ts` and owning manifest settings/features,
including scope, permissions, locked activation and remediation, in the same PR.
Check default-off, invalid enum, ownership, admin/non-admin permissions, and rejection
of premature `on`. Extend the existing settings API test path, rather than building
a second settings mechanism. Exit: scoped checks pass; settings UAT below passes.

### 1.3 Public rename and settings row (one UI session)

Depends on 1.2. Touch `apps/web/src/settings/settings-ai-sorting-row.tsx`, its parent
settings composition as needed, AI help/docs, `packages/ai/src/manifest.ts`,
`packages/chat/src/manifest.ts`, and `packages/shared/src/app-map-core.ts`. Rename
user-facing Sorting model copy to Classifier; retain internal compatibility names.
Build exactly the approved row and disclosure, with accessible labels and save
feedback from the saved record. Do not expose `on` as usable before the release gate.

Check `tests/unit/settings-ai-sorting-row.test.tsx` and a new
`tests/uat/specs/classifier-settings.uat.spec.ts`: owner signs in, opens the real
settings path, selects/clears a classifier, reloads, changes the allowed gate state,
and verifies unchanged chat behavior and forbidden premature activation. Run the
UI assertions in light, dark and one theme; record bounded DOM/network evidence.

**Early evaluation:** retain Ben's stop decision after the first settings/disclosure
review, but do not serialize independent shadow groundwork behind the rename. If
Ben rejects the extra sharing or intended latency benefit, stop further gate work.
Passing this review authorizes no data collection or live execution on its own;
the privacy, mockup, and shadow release gates still apply.

## Slice 2: tool opt-in

### 2.1 SDK contract and safe template/candidate support (one session)

Own `packages/module-sdk/src/index.ts` and a focused SDK helper if necessary. Add an
optional `classifier` declaration containing a one-line description, per-argument
enum/candidate/extraction requirements and a bounded result reply template. Reuse
risk, input/output schemas and module ID. Candidate hooks are read-only, actor-scoped,
cancellable and bounded; no arbitrary code in templates. Static enum tools need no
hook. Validate placeholders against allowed result fields and reject incomplete
contracts before listing. An absent declaration makes every existing tool ineligible.

Check one enum tool, a typed-only tool, missing required arguments, invalid template,
unknown result field, and unbounded candidate output. Document the SDK contract in
`docs/module-developer-guide.md`. Internal-only helpers need no false app-map feature;
any newly exposed opt-in capability must be declared in the owning feature metadata
and core map in this same slice.

### 2.2 External-module round trip (one session)

Own `packages/module-sdk/src/external-module.ts`,
`packages/module-registry/src/external/validate.ts`,
`packages/module-registry/src/external/tool-manifests.ts`, and the existing external
runtime dispatch boundary. Carry validated declarative templates and candidate-hook
handler references through discovery into runtime manifests. Candidate hooks must
use the existing sandbox/RPC mechanism; the SDK function form alone is not portable.
First verify and cite that runtime extension point; if it cannot support a bounded
read-only hook, owner is the module-platform implementer and dynamic external
candidates remain blocked, not silently replaced with direct database access.

Extend `tests/unit/external-module-tool-manifest-policy.test.ts` and add an installed
fixture round trip: valid opt-in survives loading, unknown/hostile declarations fail,
no opt-in stays off, two owners cannot see each other's candidate values, and handler
failure declines without a tool write. Preserve provenance and existing policy fields.
Exit: fixture load-to-gateway test passes; document external eligibility requirements
and update owning app-map feature metadata if the published capability changes.

### 2.3 First candidate declarations (one session per approved owning module)

Depends on Ben's exact shortlist and the candidate privacy decision below. For each
approved candidate in the inventory, edit only its owning manifest/tools, add the
small candidate/template helper needed, and update that manifest's features/errors/
remediations and `packages/shared/src/app-map-core.ts` where core help describes it.
No direct cross-module imports. Do not widen an existing tool's authority. Calendar
window candidates are deterministic and timezone-aware; task fields are extracted
only on capable classifiers. No live activation yet.

Check declaration-to-loaded-menu eligibility, candidate authorization, schema
validation and template output against the actual handler result. Use the existing
tool handler tests plus `tests/uat/specs/classifier-tool-menu.uat.spec.ts` to confirm
real module installation and unchanged default chat operation. User-connected
smart-home and timer tools follow Slice 2b, not a missing-module blocker. Exit: each approved module's
bounded session passes separately; no fictional tools in the shipped list.

## Slice 2b: user-connected integrations (before real shadow tool menus)

This is the headline smart-home path. Reuse each connection's synthetic module as
its classifier area. A user, not a module author, opts these tools in. Connection
and tool switches default off and are additional to ordinary integration curation.
Effective eligibility requires: enabled connection, ordinary-chat tool availability,
connection classifier switch, tool classifier opt-in, current reviewed preparation,
known reviewed risk, supported argument capabilities and current candidates when
needed. Live execution additionally requires 4.2 release eligibility and the existing
gateway's authorization. Unknown or stale means decline to ordinary chat.

### 2b.1 Connection and preparation mockup review (one design session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Owner: integrations UI implementer; Ben reviews before any UI build. Use the
design-system skill and `docs/design-system.md`. Extend the real connection detail
screen with "Let the classifier use this connection" and per-tool classifier
opt-in/out, distinct from ordinary tool curation and repeated-call switches. Use
existing `Switch`, `Field`, `Select`, `Button`, status and review primitives. Show
unknown risk, not prepared, preparing, review required, approved, stale, failed,
no tools, and disconnected states. The switch requests preparation; it does not
silently approve its output or enable any tools.

Mock up the editable review of each description, fixed-choice inputs, risk and
reply template, including the before/after diff on re-preparation. Explain setup
cost and data sharing before the model request, separately from runtime classifier
sharing. Include rejection/cancel, retry cost, keyboard access and light/dark/theme
states. Exit: Ben approves mockups; record risk and setup-definition permission
rulings when available. No UI implementation or real definition upload beforehand.

### Risk options and recommendation (Ben decides before 2b.2 ships)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

| Option                                     | Benefit                                                                                                                | Limitation and disposition                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust `readOnlyHint` directly when present | Low setup effort; many servers supply it.                                                                              | A server can lie or be wrong; absence says nothing about a lamp versus a lock. Reject as sole authority. Retain it as a visible suggestion and flag conflicting destructive hints. |
| Let the user classify each tool            | The owner can distinguish a read, a reversible device write, sending data, and destructive/security-sensitive actions. | User mistakes remain possible; explain consequences, require review, and do not let a generated draft lower risk automatically. Recommended basis for classifier risk.             |
| Unknown stays outside the gate             | Preserves safety for undescribed or ambiguous tools.                                                                   | Lower initial coverage. Recommended default combined with explicit user classification; never infer read from missing hints.                                                       |

Recommend an owner-reviewed `classifierRisk` of read/write/outbound/destructive,
with unknown represented by no approved value. Server hints and setup drafts are
untrusted inputs to the review, not proof. A lock/unlock or similarly sensitive
operation must not be treated as a harmless switch merely because both accept a
name; unresolved classifications stay unknown. Ben must approve this rule before it
becomes product behavior. Persist the review against the discovered definition.

**Preserve ordinary approval behavior:** leave synthetic manifest `risk: outbound`
and `executionPolicy: auto` intact. The reviewed classification controls only gate
eligibility and confidence thresholds; it is not a new authorization policy. All
execution still goes through the unchanged gateway authority checks. In normal
mode these outbound tools currently require a card, so the gate declines and the
default model raises it. In YOLO the existing external-tool exception may permit
execution, subject to overrides and limits; known classifier risk and the kill gate
remain additional requirements. Do not "fix" this by downgrading manifest risk.
Retain the outbound execution failure rule: after an integration attempt fails or
has an unknown outcome, show a terminal code-written message, never retry via the
default model, even if the classifier label says read. This avoids trusting a server
read hint to authorize a repeat. Any later change to ordinary policy is out of scope.

### 2b.2 Owner storage, opt-in and invalidation (one backend session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Own `packages/integrations/src/repository.ts`, `routes.ts`, shared integration API
contracts, and a new migration under `packages/integrations/sql/`. Reuse the existing
owner-only connection row: add a default-false classifier switch and a versioned
JSON preparation map keyed by discovered tool name. Each approved entry stores
opt-in (default false), reviewed risk, description, fixed-choice definitions,
reply-template contract, optional candidate-source mapping, definition fingerprint,
review timestamp, current/stale state and preparation version. Return drafts as
transient review records; store prepared text only after the user reviews, edits
and explicitly saves it. Cancelling review leaves no persisted generated draft.
Use a canonical fingerprint over the tool list, descriptions, schemas and relevant
annotations; use owner plus immutable connection ID for identity. Prepared text is
private data, not logs or job payloads. Keep RLS owner-only, including administrators,
and deletion cascading with the connection. Bound map size and input lengths.

On changed list/schema/description/annotations, mark the preparation stale and require
re-preparation plus review; new tools remain off. Compare the discovery generation
when saving a review so old tabs cannot approve a superseded draft. Changes to
connection endpoint/credentials, opt-out, deletion, preparation or risk invalidate
resolver and candidate caches immediately. A discovery failure must not preserve
classifier eligibility just because ordinary chat retains its old discovered list.
After quick checks, before a gate attempt uses a connection menu, refresh its tool
definitions within the shared deadline, coalescing simultaneous requests; a failed or changed result
declines. This is discovery, not model preparation. Never claim the current discovery
snapshot proves remote behavior cannot change after dispatch. Recheck stored revision
and opt-in at dispatch; stale preparation never triggers an automatic default-model
setup call from chat.

Check two owners/admin, forged connection IDs, default-off, per-tool exclusions,
changed/deleted/added tools, schema drift, stale review saves, discovery failure,
cache invalidation and opt-out during classification. Use
`tests/integration/integrations-classifier-settings.test.ts` under verify-gate
isolation only. Update integrations manifest settings/features/errors/remediations,
data-lifecycle declarations and the core app map in this same product PR.

### 2b.3 One-time default-model preparation (one AI/integrations session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Depends on permission for setup definition sharing and 2b.2; serialize shared AI
changes after 3.1. Add `packages/integrations/src/classifier-preparation.ts` and a
small composition-layer port that selects the user's current default chat model
through the existing AI selection machinery. Use its structured adapter with an
explicit resolved model. If that selection cannot satisfy the schema, show a setup
failure; do not silently switch to the classifier or another model. No provider or
model names in feature code. No chat turn, history, memory or device invocation.

When the user enables preparation, read each discovered tool once per definition
version and draft: a short classifier description, fixed enum/choice inputs present
in the schema, remaining inputs requiring typed extraction or a candidate source,
and a declarative reply template using allowed envelope fields. Bound concurrent
requests and token/output size. Do not invent device names, enum options, risk facts
or result fields from prose. Schema metadata and descriptions are untrusted data;
the prompt has a worked example and less than 150 words of instructions. Validate
output with schema descriptions and a boundary validator, then present an editable
per-tool diff for user acceptance. The model never writes executable template code
or approves a tool. No automatic retries that repeat the setup charge; explicit retry
is visible to the user. Re-enabling unchanged reviewed definitions reuses them.

The disclosure names the discovered names/descriptions/input schemas/annotations
sent to the user's default model, that a hosted model sends them to its provider,
and that setup and explicit re-preparation incur model usage/cost. Do not quote an
invented price. Omit transport URLs, credential configuration and headers by field, and never
include device inventories or raw tool responses in this setup request. Service-provided text
(descriptions, schema text, choice lists) is sent as written and is not scanned for secrets until
slice R2.4 adds the credential check; the notice must say so.
Definitions themselves may contain private information: real sharing waits for Ben's
ruling and the user's disclosed setup action. Reviewed descriptions/templates and
candidate labels later sent to the classifier need their separate privacy ruling.
At message time the gate uses only the classifier; setup is never repeated there.
Declines still follow the existing default-model chat path.

Check chosen-model routing, unsupported selection, call counts per version, malicious
definitions, malformed drafts, cancelled review, edited/rejected drafts and replay of
an old approval. Add `tests/unit/integrations-classifier-preparation.test.ts`. Update
the integrations manifest/core map with preparation, cost, privacy and failure recovery.

### 2b.4 Reviewed switches and editor (one UI session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Depends on 2b.1-2b.3. Own `apps/web/src/settings/settings-integrations-pane.tsx` and
focused adjacent components/API hooks. Build the agreed connection switch, tool
controls, risk choice and preparation review. Model drafts stay visually distinct
from saved approved records. Show which tool is ineligible and why; no silent opt-in
on a bulk connection switch. Render progress, saves and errors from records. Make
re-preparation/edit/review accessible without changing ordinary tool or repeat-call
controls. Match the approved empty/loading/error states. Tests cover reload, stale
review, rejection, opt-out and keyboard interaction. Run design token/class checks;
update integrations manifest and core map in the same PR. Exit: UI assertions pass;
assembled proof is the 2b.6 release requirement.

### 2b.5 Candidate preparation, runtime menus and replies (one integration session)

Own focused `packages/integrations/src/classifier-candidates.ts` and
`classifier-reply.ts` helpers, plus minimal `tool-manifests.ts`/cache wiring. Wait for
2.1's contract and 3.2's gateway interface before editing their shared boundaries.
Copy only current user-reviewed preparation into classifier metadata on synthetic
tools. Preserve ordinary manifests and curation. The gate's area is the connection;
the runtime menu uses reviewed descriptions and capability-filtered inputs.

**Candidate recommendation, conditional on Ben's privacy ruling:** the gate's setup/
explicit-refresh path may call an owner-selected exposed-device listing tool only
when it has an explicit reviewed read-only classification and the existing gateway
permits the call. This is a user-requested setup read, not a handled chat action;
shadow itself performs no candidate-tool calls or action execution. A server hint alone cannot qualify it. Use the same gateway, never
invoke MCP directly to evade confirmation; if confirmation would be needed, do not
raise a gate card, leave candidates unavailable and explain the ordinary setup path.
Validate the listing result through an explicitly reviewed extraction mapping; no
model interprets raw device results at message time. If the server cannot provide a
bounded usable list, choice-only classifiers cannot handle name-valued inputs.

Cache minimal IDs/names under the owning connection with a source/version fingerprint,
fetched time and expiry (initial maximum age five minutes, an implementation bound,
not a privacy permission). Invalidate on discovery/preparation changes, known device
list changes, refresh failure and opt-out. Never mix owners. Expired/missing/ambiguous
names exclude that tool until the user refreshes; no hot-path listing call or stale
fallback. A typed-capable classifier may extract a literal device/area name without
this list, subject to the input schema, reviewed risk and existing gateway rules;
never fabricate an ID or claim that schema validation proves a device exists.
Candidate names and prepared text feed the still-open privacy/disclosure decision.
No per-message setup model, background preparation queue or cross-user cache.

**Reply contract:** prefer the reviewed declarative template over validated result
fields. Otherwise render the code-authored envelope summary as plain text. For an
empty success summary, use exactly "Action performed successfully." for performed
and "Read succeeded." for read. For error/unknown status use "The action could not
be confirmed. Check the connected service before trying again."; never fill an error
with success text. Preserve the existing already-done, refused and truncated meanings
when supplied by `INTEGRATION_SUMMARY`; do not paraphrase suppression as fresh success.
Do not display arbitrary remote `detail` or ask a model to invent a reply. An
informational read that needs content cannot count as handled on "Read succeeded."
alone: it needs a useful reviewed template or must remain ineligible. After a
mutating attempt, empty/malformed output cannot trigger fallback execution.

Check device rename/removal, expiry, no listing tool, denied listing, false hints,
unknown risk in YOLO, choice-only versus typed input, cached owner isolation, empty
summary, remote error, suppression, truncation and partial mutation. Add
`tests/unit/integrations-classifier-runtime.test.ts`. Update integrations manifest
features/errors/remediations and core map in this same PR.

### 2b.6 Real integrations-screen proof (one UAT session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Depends on 2b.1-2b.5. Add
`tests/uat/specs/classifier-integrations.uat.spec.ts` using real Home Assistant or a
faithful fake MCP server with a name-valued light switch, read-only device listing,
a sensitive unlock action, missing/false hints and a changeable tool list/schema.
Connect through the real integrations screen, discover and curate tools, enable
preparation, edit/approve a draft and opt in only selected tools. Assert all-off
initial state, unknown-risk exclusion, owner isolation, staleness/re-preparation,
disclosure, and unchanged ordinary-chat approval in normal and YOLO modes. Count
setup model calls and prove reconnecting unchanged configuration does not prepare
again. No fixed pretend module or bypass of the real connection setup.

Before 3.5 exists, prove persisted setup and the real menu resolver with assertions;
this is not yet end-to-end shadow proof. Then extend the same fixture in 3.5 for
classifier requests with zero preparation calls at message time and zero gate action
execution. In 4.3, after shadow approval and the marker, prove a permitted light
command executes once in YOLO, normal-mode confirmation declines to the default
model, and unknown/sensitive unapproved tools remain ineligible. Keep gate privacy,
rate/override checks and no-retry-on-unknown-outcome assertions. Attach bounded
redacted UI/network assertions and exit code to each future product PR, no screenshots.
Run only on an isolated dev target after verify-gate setup. Map/manifest truthfulness
is checked against the actual integrations screen and its available recovery actions.

## Slice 3: shadow mode

### 3.1 Classifier routing contract (one AI session)

Own a new `packages/ai/src/structured/classifier.ts`, package exports, and the minimal
single-attempt extension to `generate-structured.ts`. Resolve the existing binding
through `AiRepository`; report choice-only versus typed-extraction capability without
provider names in gate logic. Reuse `generateChoices` or the structured transport,
retaining complete choice scores and validating a common result shape. Do not change
the yes/no helper's callers. Pin the resolved model for both stages. Add no fallback
inside classification and no repair retry. Unsupported capability declines.

Check different configured classifier selections, no binding, disabled model,
routing restrictions, malformed/missing scores, and timeout after stage one. Count
transport calls to prove at most one attempt per stage. Verify the chosen default
chat model is never called by this helper. New tests:
`tests/unit/ai-classifier.test.ts`. Exit: focused tests pass.

### 3.2 Gateway decline and shadow evaluation (one gateway session)

Own `packages/ai/src/gateway/gateway.ts` and adjacent gateway types/policy tests.
Extend the existing call path with an explicit no-confirmation execution mode and
a dry-run evaluation that shares its policy decision. Refactor only the policy
portion needed to prevent divergence. Default callers retain current behavior.
Before any handler call or card emission, return a typed decline when confirmation
would be required. Shadow evaluates without creating cards, consuming allowance or
writing an executed-action audit. The live path still validates current membership,
trust, override and limits at dispatch time; a prior dry-run is never authorization.
Expose attempted execution and module-reported errors truthfully to the gate.

Extend `tests/unit/gateway-policy.test.ts` and
`tests/unit/mcp-gateway-units.test.ts`: normal/YOLO crossed with read/write/outbound/
destructive, trusted/untrusted family, per-call override, rate limit, removed tool,
invalid token, invalid arguments, and module-reported failure. A would-confirm gate
call must produce zero cards and zero handler invocations. Observe the test fail
with the no-card guard removed, then restore it. Exit: existing and new policy tests
pass; same-slice chat manifest/core map describe decline-to-normal-approval behavior.

### 3.3 Gate decision engine (one chat session)

Start with synthetic fixtures after 2.1; integration-menu wiring waits for 2b.5.

Own new `packages/chat/src/live/classifier-gate.ts` and
`tests/unit/chat-classifier-gate.test.ts`. Implement quick checks, module/tool menus,
two stages, full validation, risk thresholds, margin, shared deadline and cooldown.
Keep the engine small and inject the AI/gateway/candidate ports; do not put the whole
implementation in the already-large session manager. Handle every invariant above.

Check UTF-8 byte boundaries, attachments, missing model, off, no eligible tools,
context-dependent language, every risk threshold, exact margin boundary, malformed
answers, candidate revocation, deadline/cooldown expiry, cancellation and late results.
Observe the risky-tool test fail with its confidence bar removed; restore it and
record both results. No threshold evidence means no live eligibility. Exit: focused
tests pass and shadow reasons are declared in the chat manifest/core app map with
useful remediation, in the same PR.

### 3.4 Owner-only shadow records (one persistence session)

Own a new `packages/chat/src/classifier-shadow-repository.ts`, a new migration under
`packages/chat/sql/`, chat database types/manifest migration registration, and
`tests/integration/chat-classifier-shadow.test.ts`. Do not edit applied migrations.
Store actor, turn correlation ID, timestamps, original message text, gate mode,
classifier configuration identity/version, module/tool, confidence and margin,
connection ID and reviewed preparation/risk version for integrations,
threshold version, decision/reason, timing, and first-model-tool comparison status.
Avoid storing raw argument/result payloads merely for convenience. Use owner-only
RLS for reads and writes with no admin or thread-sharing exception. Retention is settled by
ruling 16 (kept forever; owner deletes on request); bound review reads. No text in logs, job payloads
or public PR evidence. A record-write failure must not prevent the default turn.

Check two owners, shared-thread recipient, admin, missing actor, correlation before/
after classifier completion, missing model tool call, cancellation, storage failure,
and private-chat non-persistence. Observe the owner-isolation check fail when its
owner predicate is deliberately weakened in an isolated disposable database, then restore it. Before any
DB command the implementer must use the verify-gate skill and its isolated-target
procedure; this planning session runs none. Exit: scoped database proof passes;
privacy behavior and errors are declared in the same slice's chat manifest/core map.

### 3.5 Runtime wiring and shadow live proof (one integration session)

Depends on 1.2-1.3, 3.1-3.4 and 2b.6 for the user-connected pilot. First-party
2.3 and external-module 2.2 are required only for their respective tool menus.

Own `packages/chat/src/routes.ts`, `packages/chat/src/live/runtime.ts`,
`packages/chat/src/live/chat-session-ports.ts`, the thin manager hook and
`tests/uat/specs/classifier-shadow.uat.spec.ts`. Wire dependencies from the existing
composition root. Launch the shadow attempt under the turn's cancellation lifecycle
while the default turn proceeds as today. Observe the first model tool record in
`runTurn`'s transcript processing; normalize transport prefixes and correlate by a
server turn ID, not actor alone. Do not count later matching tools as a first match.
Bound pending correlation state and clean it on completion/cancellation.

Through the actual UI, prove off makes no classifier request; shadow records a
decision, makes zero gate-origin tool executions and creates no gate card; the default model still
answers once with the original text. Include an attachment, oversized multibyte
message, timeout, malformed answer, cooldown, simultaneous surfaces and a cancelled
turn. Show normal and YOLO behavior. Update chat features/errors/remediations and
core app map in this PR. Exit: live proof linked on the future product PR with exit
code and redacted assertions; collect shadow data only after privacy decisions clear.

2b.5 wiring notes. This lane also wires the pieces 2b.5 left as injected ports:

- the explicit user-requested candidate refresh uses the gateway's no-card
  `callToolForGate` path through `CandidateListingPort`; hand the port
  `response.structuredData` (the outcome envelope), never the whole response
  and never the rendered text, whose `<tool_result source=...>` boundary lines
  would become candidate names. Shadow makes no candidate-tool call and no
  listing call happens on a message turn;
- the connected-tool reply renderer may return null after a mutating attempt;
  treat that as a terminal code-written failure and never run the tool again;
- the empty-success performed/read fallback currently keys off the server's
  read-only hint, not the owner-reviewed risk; resolve it when wiring the menu;
- two preserved `INTEGRATION_SUMMARY` strings ("answer with what you have" and
  "ask for a narrower query") are model-facing and would reach the user as
  written; decide their user-facing wording here.

### 3.6 Model activity log screen (one UI session)

Owner: UI implementer. Depends on 3.4 (shadow records). Build the admin-only screen agreed in
`docs/superpowers/mockups/classifier-gate/audit-log.html`: a day-grouped feed of every model call
(classifier, chat answer, background task) with action, one-line outcome, time, kind, actual model name
and result, and filters for kind, model, result and time. It shows the action taken, never the chat
text. Reads through an admin-gated endpoint; empty and no-match states as mocked. Lines are kept
indefinitely with no purge job (ruling 14); drop any retention notice from the mockup. Store each call
as one flat row of short plain-text fields (time, kind, action, outcome, model name, result) so it
renders directly as a web table and can be paged by time. Ben confirmed recording chat answers and
background tasks (ruling 12) and indefinite keeping (ruling 14). The row never holds chat text,
prompts, tool arguments or secrets. Add the screen to the app map. Tests: a non-admin cannot read it,
a row carries no message text, and old rows remain readable. Exit: live-path proof on a dev instance
through the real screen.

Coverage (ruling 15). There is no single model router today. Calls go through three central
functions (`generate-structured.ts`, `generate-text.ts`, `generate-choices.ts`), but several features
build provider adapters directly and two paths run whole CLI sessions. Close the gaps in this order:

- Record at the provider-adapter boundary (HTTP adapter generate, structured and transcribe; CLI
  structured adapter generate) so the three central functions and most direct callers are covered.
- Record the system-one `fetch` in `generate-choices.ts` separately; it skips the adapters.
- Record one row per turn for live chat (`chat-session-manager.ts` submit) and module-build sessions
  (`module-build-live-agent.ts`, `module-build-codex-exec-session.ts`). Inner tool-loop calls are not
  visible, so the row is per turn.
- Record embeddings at the embedding provider factory (`embedding-provider-config.ts`), aggregated
  per job rather than per chunk.
- Record provider probes and CLI check turns (`provider-probe.ts`, `cli-tools-refresh-wiring.ts`).
- Prefer moving direct adapter callers (commitments, chat distillation, task search, transcription,
  persona preview, Workshop reply) onto the central functions where that is a small change.

Add a guard test that scans the source for adapter construction and CLI spawns of model binaries and
fails when a new call site appears outside the recorded seams. The admin terminal is out of scope; it
is a human running a CLI by hand.

This is too much for one session. Split it into 3.6a (log table, endpoint, screen, adapter-boundary
recording) and 3.6b (choices, sessions, embeddings, probes and the guard test) when filing issues.

## Slice 4: prepare and turn on

### 4.1 Handled-turn lifecycle, initially unreachable live (one chat session)

Own the manager hook, `packages/chat/src/live/persistence.ts`,
`packages/chat/src/live/chat-session-ports.ts`, `packages/chat/src/repository.ts`,
`packages/shared/src/chat-api.ts`, and transcript origin types. Add a gate-origin
completion contract carrying tool identity, decision correlation and outcome. Keep
existing model-origin history readable. Mint/revoke the gate token through the real
composition root without launching an engine; use the gateway from task 3.2.
Persist and emit exactly one normal chat reply from the result template or terminal
failure record, with action results/cache invalidations preserved. Do not record a
fictional default-model execution or usage count.

Ensure a later default-model turn can see completed gated turns in normal history:
a warm model session will not have received them. Mark it for normal history replay
on the next default turn without submitting a synthetic turn during the gated reply.
Retain existing private-chat behavior and cancellation cleanup. Gate storage/render
failure after a mutating attempt must never trigger default-model replay. If Stop
arrives after dispatch, retain the action outcome and do not classify cancellation
as permission to retry; the classification deadline is not a tool-execution deadline.

Check cold and warm sessions: successful handling makes zero engine-launch/submit
calls, fallback submits original text once, read failure falls back, mutating partial
failure never retries, subsequent conversational reference has normal history, and
HTTP/SSE/history agree. Tests: `tests/unit/chat-classifier-live.test.ts` and extended
live persistence tests. Activation remains blocked. Update chat manifest/core map
truthfully to describe implementation as unavailable pending review.

### 4.2 Shadow review and release eligibility (one review/backend session)

_Superseded in part by revision 2 (2026-10-03); see "What this supersedes"._

Owner: build coordinator and Ben; depends on 3.5. Present owner-authorized aggregate
results for each candidate: sample count, review window, first-call agreement,
argument review where relevant, declines, unknowns and latency. Do not publish message
text. Ben sets the acceptable rate and window after data exists and chooses the tools.
Persist the reviewed tool/configuration versions as release eligibility, empty by
default; enforce it server-side alongside the state. Do not hardcode a guessed rate
or grant one tool eligibility based on another's aggregate.

Check that no approval, insufficient evidence, changed classifier/schema, or a
revoked approval denies live execution. Same-PR map/manifest updates explain eligibility
and how to return to off/shadow. Exit: Ben's decision recorded; if criteria fail,
remain in shadow or stop. This task does not itself enable production actions.

### 4.3 Real activation and live-path proof (one release session)

Depends on 4.1, 4.2, **5.1 and 5.2**, and all candidate-specific blockers. Enable only
Ben-approved tools on a dev instance and exercise
`tests/uat/specs/classifier-live.uat.spec.ts` through actual signup/settings/module/chat
UI. Prove correct result plus marker with no default-model turn; low confidence and
unknown arguments fall back; approved normal and YOLO tools follow the same gateway
policy, including the integration-specific normal-mode decline and existing YOLO
exception recorded in the revision ledger; a tool requiring approval declines and
the default model shows the usual
card exactly once. Include rate limits, per-call overrides, partial write failure,
read failure, stop, settings rollback to off and refreshed history.

Record the live test run, exit code and bounded redacted assertions on the future
product PR. No screenshots for this gate. Update core map and each activated owning
manifest in this same PR, including supported actions, errors and remediation. Exit:
proof passes and Ben's release gate is met. Otherwise report code-complete, unverified;
do not merge, mark Done, or turn on for real users.

## Slice 5: marker on handled replies

Listed fifth to preserve the spec's backbone; it is a hard predecessor of 4.3.

### 5.1 Reply-marker mockup review (one design session)

Depends on the origin contract in 4.1; may be reviewed earlier with 1.1. Use the
design-system skill and shared `Badge`/`InfoTip` or existing caption primitives.
Mock up a normal reply with "Answered without the main model", a terminal tool
failure, history after refresh, small screens and accessible keyboard/screen-reader
text. The marker reads origin metadata, never parses reply prose. Capture Ben's
agreement in the spec **before** task 5.2. Exit: agreed mockup, no UI implementation.

### 5.2 Persisted and live marker rendering (one UI session)

Own `apps/web/src/chat/message-row.tsx`, `apps/web/src/chat/chat-drawer.tsx`,
`packages/ui/src/chat-thread.tsx` and the history/stream adapters carrying their
records. Use the existing shared primitive to avoid two diverging marker designs.
Pass the origin through `packages/chat/src/live-routes.ts` response serialization
and shared response schemas as needed; dropping unknown fields must not erase it.
Old/default-model replies have no marker; live, refreshed, surface-specific and
private transient handled replies agree. No fabricated model/provider label.

Check `tests/uat/specs/classifier-marker.uat.spec.ts` through both drawer and module
thread surfaces, including HTTP completion/SSE ordering and reload. Run token/class
checks and UI assertions in light/dark/one theme. Update chat manifest feature/error
metadata and `packages/shared/src/app-map-core.ts` in this same PR. Exit: mockup
matches, executable assertions pass, and proof is attached before 4.3 can activate.

## Verification procedure for implementers

Commands below describe future build work; none of the database or live suites is
run for this documentation assignment. Read `.claude/skills/verify-gate/SKILL.md`
before any database test or full foundation gate, select its isolated target and
follow its setup. Never use a default live database. Keep command exit codes intact;
no piped verification. Use the repository's existing test runner and frameworks.

| Scope                                      | Command (after the named test exists)                                                                         | Expected    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------- |
| Docs                                       | `git diff --check`                                                                                            | Exit 0      |
| Plan formatting, if dependencies available | `pnpm exec prettier --check docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`                    | Exit 0      |
| Settings UI                                | `pnpm exec vitest run tests/unit/settings-ai-sorting-row.test.tsx`                                            | Exit 0      |
| AI contract                                | `pnpm exec vitest run tests/unit/ai-classifier.test.ts`                                                       | Exit 0      |
| Gateway                                    | `pnpm exec vitest run tests/unit/gateway-policy.test.ts tests/unit/mcp-gateway-units.test.ts`                 | Exit 0      |
| Gate decisions                             | `pnpm exec vitest run tests/unit/chat-classifier-gate.test.ts`                                                | Exit 0      |
| Handled lifecycle                          | `pnpm exec vitest run tests/unit/chat-classifier-live.test.ts`                                                | Exit 0      |
| External declaration                       | `pnpm exec vitest run tests/unit/external-module-tool-manifest-policy.test.ts`                                | Exit 0      |
| RLS, only after verify-gate isolation      | `pnpm exec tsx scripts/test-integration.ts tests/integration/chat-classifier-shadow.test.ts`                  | Exit 0      |
| UI slices                                  | `pnpm check:design-tokens` and `pnpm check:ui-classes` (separately)                                           | Each exit 0 |
| Changed product scope                      | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm build:app-map` (separately) | Each exit 0 |

Slice 2b adds `pnpm exec vitest run tests/unit/integrations-classifier-preparation.test.ts tests/unit/integrations-classifier-runtime.test.ts` (expected exit 0) and, only after verify-gate isolation, `pnpm exec tsx scripts/test-integration.ts tests/integration/integrations-classifier-settings.test.ts` (expected exit 0). Its live suite is `pnpm test:uat classifier-integrations.uat.spec.ts` (expected exit 0). Observe the unknown-risk exclusion test fail when that guard is removed, restore it and rerun; fixture hints must never become authority.

Each slice's named UAT runs with `pnpm test:uat <named-file>.uat.spec.ts` after the
verify-gate/dev-instance procedure; expected exit 0. Replace the placeholder with
that slice's filename, for example `pnpm test:uat classifier-shadow.uat.spec.ts`.
Observe it pass and attach assertions proving the real UI called the new production
path. Internal SDK/AI/gateway tasks use their end-to-end fixture/wiring tests until
the slice's UI path exists; they do not count as delivered user behavior alone.
Security negative controls intentionally exit nonzero with the guard removed; restore
the guard, rerun to exit 0 and retain both observations. Do not commit weakened guards.

## Rulings (Ben, 2026-10-01; ruling 16 added 2026-10-02)

Rulings 17 to 23 (2026-10-03) are in "Revision 2" above.

These answers supersede the matching "Decisions still needed" entries below.

1. **Gate state scope: admin-wide.** One switch (off, shadow, on) for the instance, set beside the
   Classifier binding through the existing admin configuration boundary. Not per user. The setting
   help text must say every user's eligible messages go to the classifier provider when it is on.
   Unblocks 1.2.
2. **First built-in tool: calendar only.** `calendar.listVisibleEvents` opts in. `tasks.create`
   waits for a classifier that can extract typed values. Lights and timers arrive through
   user-connected integrations (slice 2b). Unblocks 2.3 for calendar only.
3. **Gate-raised approval card: not in version one.** Revisit after shadow data.
4. **Shadow agreement rate and window: set when data exists.** No number is chosen now.
5. **Connected-tool risk: user reviews each tool.** The server hint is a suggestion only, and a tool
   without a confirmed label stays out of the gate. Unblocks 2b.2.
6. **Setup draft: the default model may read discovered tool definitions once at setup.** The user
   reviews and edits the draft before it is stored. Unblocks real definition uploads in 2b.3.
7. **Connected tools and approval: YOLO only first.** The gate acts on connected tools only when the
   existing gateway rules would run them without a card (today, YOLO). Otherwise it declines and the
   default model shows the usual card. A per-tool "run without asking" setting for both paths is a
   later, separate spec.

8. **Classifier data ceiling: anything the default model would see.** This resolves the spec 3.3
   against 3.4 conflict. Prepared descriptions and candidate lists (device names) are allowed.
   Credentials and secrets stay excluded, as they are for the default model. Version one still sends
   only the message and menu to keep calls cheap; adding recent turns or memory is a later choice
   inside the ceiling. The setting help text must still say messages reach the classifier provider.
9. **Private chats bypass the gate.** No classifier call and no shadow record. This replaces the
   incognito open question in 3.4 and 3.5.
10. **Shadow retention: 7 days.** Records, including message text, are purged after 7 days by a
    scheduled job that 3.4 must include and test. **Superseded 2026-10-02 by ruling 16.**

11. **No reply marker.** Slice 5 (5.1, 5.2) is superseded. Replies from the gate carry no marker.
12. **Model activity log replaces it.** An admin-only log of every model call (classifier, chat answer,
    background task) showing the action, outcome, model name and result, not the chat text, with
    filters. Ben ruled on 2026-10-01 that it covers all model calls, not only the classifier. Mockup
    agreed. Build task 3.6.
13. **Mockups agreed** for tasks 1.1 and 2b.1: `docs/superpowers/mockups/classifier-gate/`.
14. **Model activity log is kept indefinitely.** No purge. Store it in a simple format that renders
    well on the web and stays auditable for as long as possible (Ben, 2026-10-01). Shadow records
    (ruling 16) are also kept indefinitely and deleted only when the owner asks; the activity log
    never holds chat text.
15. **The activity log records every model call.** Automated jobs, scraping, sorting, briefings,
    embeddings and probes all appear, not only chat (Ben, 2026-10-01). No single seam covers this
    today, so task 3.6 owns the coverage work described there.
16. **Shadow retention: kept forever, deleted on request (Ben, 2026-10-02).** Ruling 10 is
    superseded. The fixed 7-day purge job and its database function are removed. An owner can
    delete their own shadow records on request, enforced by row-level security, with no admin
    bypass; the rows also go with account deletion through the existing `ON DELETE CASCADE`.
    Private chats never take part: no classifier call and no record. Build task #2908; lane plan
    `2026-10-02-classifier-shadow-retention.md`.

Still open: the external candidate-dispatch proof (module-platform implementer). Closed:
shadow retention and private chat, resolved by ruling 16 (2026-10-02).

## Decisions still needed from Ben

The original four questions are unchanged:

1. Is gate state per user or admin-wide? Blocks 1.2 and final settings design; the
   classifier binding remains admin-owned under either choice.
2. Which first-party tools opt in first? The exact available candidates are above;
   user-connected tools follow the separate owner opt-in in 2b. Blocks 2.3 for any unapproved tool, not the default-off SDK work.
3. Should a later version let the gate raise its own approval card? No version-one
   task implements that, regardless of the eventual answer.
4. What shadow agreement rate and review window permit activation? Set only when the
   data exists; blocks 4.2/4.3. Do not fill in a threshold for Ben.

Revision 1 adds two decisions:

5. Which risk rule applies to discovered tools? Recommend owner-reviewed classifier
   risk, server hints as suggestions only, and unknown ineligible. Blocks 2b.2
   eligibility behavior; ordinary gateway approvals stay unchanged under any choice.
6. May the user's default model read discovered tool definitions during setup
   preparation? Blocks real definition uploads in 2b.3; fixtures can proceed.
   Preparation is one-time per version with explicit user review, not a model call
   added to every chat message.

Additional seams requiring a ruling, not an invented implementation assumption:

- **Prepared text and candidate privacy — resolved by ruling 8 (Ben, 2026-10-01).**
  Ruling 8 set the classifier's data ceiling to anything the default model would see:
  prepared descriptions and candidate lists (device names) are allowed, while credentials,
  secrets and example values stay excluded. The read-only device-list preparation in 2b.5
  is permitted under that ceiling, and only when the reviewed record marks the listing tool
  read-only and the existing gateway permits the call. This reconciles spec 3.3 and 3.4.
  Keep real definition sharing, prepared text sharing and device inventories distinct, as
  none is implicitly approved by the others.
- ~~**Shadow retention/private chat (Ben, before 3.5 collection)**~~ — **resolved by ruling 16
  (Ben, 2026-10-02):** records are kept forever and deleted on the owner's request; private
  chats never take part. Task #2908.
- **External candidate dispatch (module-platform implementer, before 2.2 completion):**
  prove the bounded actor-scoped runtime hook with a source citation and fixture.
  This plan verified declaration loading, not a preexisting candidate-hook protocol.

## Planning-session completion

Deliver only this plan. Review the entire document for credentials, private hostnames,
LAN addresses and personal data; keep workspace references under `~/Jarv1s`. Run
bounded documentation checks, commit only this file with the required co-author
trailer, leave the worktree clean, do not push or create tracking artifacts, and
notify Ben with the task brief's exact `needs-ben` command.
