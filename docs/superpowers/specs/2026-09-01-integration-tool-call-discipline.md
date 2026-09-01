# Integrations — Tool Call Discipline

**Date:** 2026-09-01

**Status:** Approved by Ben 2026-09-01 (chat, after two Fable review rounds)

**Issue:** #2175

**Follows:** `docs/superpowers/specs/2026-08-31-integrations-mcp-client-foundation.md` (#2162,
shipped as #2171). This spec fixes behaviour observed on the first live connection.

## Context

The integrations foundation shipped and works. Ben connected Home Assistant to production on
2026-09-01 and the end-to-end path is proven: discovery found 75 tools, and chat successfully
turned a kitchen light on and off.

It is slow, and the measurements say the slowness is entirely ours.

**Measured on the live prod instance, 2026-09-01:**

| Measurement                                                 | Value    |
| ----------------------------------------------------------- | -------- |
| Connect to the MCP server                                   | 8–52 ms  |
| One tool call, round trip                                   | 45–55 ms |
| One user request ("turn the kitchen light off"), end to end | ~13 s    |
| Tool calls Moss made for that one request                   | 5        |

The audit log for that single request:

```
16:01:31  HassTurnOff     success
16:01:35  HassTurnOff     success      <- same action, again
16:01:38  GetLiveContext  success      <- whole-house state, ~20,000 chars
16:01:41  GetLiveContext  success      <- again
16:01:43  HassTurnOff     success      <- and again
16:01:44  assistant replies "Kitchen Lights are off."
```

The remote service answered every call in about 50 ms. The remaining ~12.7 s is Moss: repeating a
completed action, and re-reading the entire house twice to verify something the first call had
already confirmed. Home Assistant's own reply to `HassTurnOff` was
`{"success": [{"name": "Kitchen Lights", ...}], "failed": []}` — an explicit, unambiguous
confirmation that the model did not act on.

None of this is Home Assistant-specific. Moss controls none of what a connected service does:
how many tools it offers, how large its responses are, or whether repeating an action is safe.
Home Assistant is a friendly case — a local network, fast responses, harmless repeats. The next
connection someone makes will not be, and the person who feels it is whoever connected it.

**A second, constant cost.** All 75 discovered tools are enabled, and their definitions total
**28,359 characters** attached to every chat turn, including turns that have nothing to do with
the connected service. The curation rule intended to prevent this
(`isGroupOptIn` in `packages/integrations/src/curation.ts`) requires the service to sort its own
tools into groups. `discoverMcpTools` hardcodes `group: ""` for every MCP tool, so the rule can
never fire for an MCP connection at any tool count. The 30-tool threshold is dead code for the
MCP half of the product.

**A safety concern, not only a speed one.** Repeating a light switch three times is harmless.
The same connection also exposes `HassBroadcast`, `AddMovie`, `AddTaskWork`, `StartTask` and
`HassListAddItem`. Identical repeat behaviour against any of those is a duplicated side effect on
the user's real accounts and devices.

## Goals

1. A completed action is not repeated within a single user request, unless the service has said
   the repeat is safe.
2. Moss does not re-read state to verify an action whose own reply already reported success, and
   does not answer from a snapshot taken before an action it has since performed.
3. A connected service cannot flood a chat turn with an unbounded response.
4. The tool-picking rule works for every service, including services that do not group their tools.
5. Per-call timing is recorded, so a slow integration is visible rather than inferred.
6. Moss does not rebuild a user's whole tool list from the database on every single tool call.
7. Every fix is service-agnostic: it must help the second and hundredth integration as much as
   Home Assistant.

## Non-Goals (this milestone)

- Per-service adapters, allowlists, or special-casing Home Assistant in any form.
- Changing the chat assistant's general (non-integration) tool behaviour — with one stated
  exception: section 7 records how long every audited tool call took, integration or not. That is
  telemetry, not behaviour, and it is worth more when it covers everything.
- A caching layer for integration reads across requests. In-request de-duplication only.
- Streaming or partial tool results.
- Reworking the confirm/approval gate. These tools stay `risk: "outbound"`,
  `executionPolicy: "auto"`. The read-versus-acts information captured in section 1 is used by the
  rules in this spec only; wiring it into the approval gate — so that a tool the service marked
  destructive asks before running — is the obvious next step and is deliberately left to its own
  spec, because it changes what the user is asked to approve.
- Trusting a service's hints for anything safety-critical. A server can lie or be wrong. The hints
  are used only to _relax_ a restriction (allow a repeat) or to _tighten_ one, never to skip a
  check the user relies on.

## Design Rulings

- **The proxy is the enforcement point.** Every rule here lives in the integrations tool proxy
  (`packages/integrations/src/tool-manifests.ts`) or its collaborators, not in the chat gateway
  and not in the model prompt alone. A rule that depends only on the model following instructions
  is a nudge, not a guarantee; the ones that protect against duplicated side effects must hold
  even when the model misbehaves.
- **Fail visible, not silent.** When Moss suppresses, truncates, or refuses a call, the model is
  told plainly and in a form it can act on. Silent trimming produces confident wrong answers.
- **Defaults protect the user who connected something unknown.** The more a service exposes, the
  more Moss asks rather than less.
- **When a service says nothing about a tool, assume it changes something.** Every rule below has
  a branch for "the service told us this tool only reads" and a branch for everything else. A tool
  with no information lands in the second branch. Guessing "read" on a tool that in fact books a
  flight is the failure we cannot take back.

## Architecture

### 1. Knowing which tools act and which only read

**Problem.** Sections 2 and 4 need to treat a tool that changes the world differently from a tool
that only looks at it. Today Moss has no way to tell them apart: `buildToolManifest` stamps every
integration tool with the same risk level, `outbound`, and this spec does not change that (see
Non-Goals). Any rule written in terms of that risk level would be a rule with one branch.

The information exists and Moss is throwing it away.

- **MCP.** The protocol lets a server annotate each tool as read-only, as safe to repeat, or as
  destructive. `discoverMcpTools` maps each discovered tool to name, description, an empty group
  and an input schema, and discards everything else — including those annotations. Home Assistant
  does supply them.
- **OpenAPI.** A spec states each operation's HTTP method. Moss already reads the method and
  already treats a plain fetch differently from everything else for retry purposes, so the split
  costs nothing new.

**Change.** Discovery keeps three facts per tool alongside name and description:

| Fact                                    | Where it comes from (MCP)  | Where it comes from (OpenAPI)              |
| --------------------------------------- | -------------------------- | ------------------------------------------ |
| Only reads, changes nothing             | the read-only annotation   | the method is a plain fetch (`GET`/`HEAD`) |
| Safe to call twice with the same result | the idempotent annotation  | `GET`/`HEAD`/`PUT`/`DELETE`                |
| Destructive                             | the destructive annotation | not derivable; left unset                  |

Each fact is three-valued: yes, no, or **the service did not say**. "Did not say" is treated
exactly like "no" everywhere a rule branches, per the design ruling above.

**Storage costs nothing.** Discovered tools are already stored as a JSON document
(`discovered_tools` in `packages/integrations/sql/0207_integration_connections.sql`), so the three
new fields need no migration and no schema change — only a wider shape in
`packages/shared/src/integrations-api.ts` and readers that tolerate their absence.

**Existing connections.** Rows discovered before this change carry no hints, so every one of their
tools reads as "did not say" and gets the conservative branch. That is the correct behaviour, not
a bug, and it is also exactly today's behaviour. Pressing the existing refresh button on the
connection page re-runs discovery and picks the hints up. The connection detail page says so in
one line rather than requiring anyone to know it.

### 2. Uniform outcome envelope

**Problem:** `callMcpTool` returns the service's raw text under a `result` key and
`buildToolManifest` passes it through. Success is implied by the absence of an error field. The
model receives an arbitrary service-authored blob and must infer whether the action happened.
Home Assistant's reply to the light command said `{"success": [...], "failed": []}` — an explicit
confirmation the model still did not act on.

**Change:** every integration tool result becomes a fixed shape, independent of kind and service:

```ts
{
  status: "ok" | "error",
  action: "performed" | "read",     // from the read-only hint of section 1
  summary: string,                  // one line, Moss-authored
  detail: unknown                   // the service's own reply, unchanged
}
```

`action` is `"read"` only when the service said the tool is read-only; `"performed"` otherwise,
including when the service said nothing. The service's payload passes through untouched under
`detail` — Moss never rewrites or summarizes a service's words, only frames them.

**Paired instruction.** The chat system prompt gains one rule, applying to integration tools
generally: _when a tool returns `status: "ok"` and `action: "performed"`, the action happened; do
not call a read tool to confirm it._ This is the nudge half; section 3 is the enforcement half
that holds when the nudge fails.

### 3. In-request duplicate suppression

**What "one request" can actually mean here.** Nothing in the code hands a tool the identity of
the user's turn. A tool's execute is given the acting user, a fresh per-call identifier, and the
chat session it belongs to (`ToolContext` in `packages/module-sdk/src/index.ts`); the per-call
identifier is new on every call, and the chat session outlives many turns. There is no turn
boundary the integrations code can see, and inventing one means changing a type every module in
the product depends on — too much for this milestone.

So the store is scoped by **acting user and chat session**, with entries that expire after **30
seconds of quiet**, and it lives in the integrations package rather than in a closure (see section
8 for why a closure would not survive). The observed 5-call burst took 13 seconds, so 30 gives an
assistant turn generous room. The window is a stand-in for a turn boundary and the spec says so
rather than pretending otherwise.

**The window spans turns, and that is the cost.** A user who says "turn it off", waits 30 seconds
and says "turn it off again" is inside one window, and the second command would be blocked. Two
rules keep that from becoming a trap:

- **A blocked repeat never refreshes the window.** Only a call that actually reached the service
  extends it. Without this rule, someone asking repeatedly would be blocked forever, each attempt
  pushing the expiry out.
- **The window is short enough that asking again works.** Shorter is better than longer here, and
  30 seconds is the shortest value that still comfortably covers one burst.

This is the honest trade: a small chance of telling the user "I already did that once" when they
meant it twice, against silently doubling a purchase. If a future change gives tools a turn
identifier, this becomes exact and the window disappears — recorded under future direction.

**One path has no chat session.** When one tool reads through another, the gateway sets the chat
session to an empty string (`gateway.ts`, the cross-tool read path). Every such call for a user
therefore shares a single bucket. That is still per-user and still safe; it just means those calls
de-duplicate against each other more broadly than a turn. Worth knowing, not worth special-casing.

Entries are held in memory only, never written to the database, never logged, and never shared
between users: one user's stored results are unreachable from another's, because the key starts
with the acting user.

**Do not solve this by widening the shared per-request context.** `AccessContext` carries the
acting user and a request identifier and nothing else; a field was removed from it on purpose and
re-adding one re-opens a closed design (hard invariant). The store keys off what a tool is already
given.

Within that scope the proxy remembers each call keyed by connection, tool name, and the call's
arguments with their keys put in a fixed order (so the same arguments written in a different order
are one key). This is de-duplication inside a burst, never a cache the user can be served stale
data from a minute later.

**A repeat of a tool that only reads.** Return the stored result, marked "Unchanged result from
earlier in this request." **Except** if any tool on that connection has successfully performed
something since that read was stored — then the stored answer is stale and the read runs again for
real. Replaying a pre-action snapshot would have the model report the old state as current, which
is worse than the extra call. A successful performed call clears every stored read for its
connection.

**A repeat of a tool that performs something.** Do not re-invoke, with one exception: if the
service annotated the tool as safe to call twice, let it through — that is the service telling us
the repeat is harmless.

When a repeat is blocked, the returned summary says so plainly: "This was already done once in
this request and was not done again." It does not claim a second success.

**A blocked repeat returns the one-line summary only, not the stored payload again.** Re-sending a
stored result would let a loop of identical reads re-inject up to 8,000 characters per repeat at no
cost, defeating the budgets in section 5 entirely. The model already has the first result in its
own history; it does not need a second copy. The one exception is a repeated read that is still
valid and short — under 500 characters — where sending it again is cheaper than the model
re-deriving it. The model needs to be
able to tell the user "I turned it off once" rather than "I turned it off twice", and a summary
that reads like a success makes the honest answer impossible.

**Why not just let repeats through.** Repeating a light switch is harmless. The same connection
also exposes tools that broadcast a message, add a film to a watchlist, create a task and add an
item to a shopping list. The observed behaviour — the same command sent three times in one request
— duplicates real side effects on the user's real accounts.

**The cost this accepts.** "Skip two tracks" or "turn the volume up twice" is a request where the
user genuinely wants the same call made twice with the same arguments. If the service marks those
tools safe to repeat, they work. If it does not, the second one is blocked and Moss says so —
the user can ask again. Silently doubling a purchase is the failure we will not accept to avoid
that one.

**Escape hatch.** A per-connection setting, off by default, turns suppression off for a named
tool, for a service that needs repeated identical calls and does not annotate them. It is an
in-app setting on the connection detail page — never a deployment settings file, per the rule that
a new feature must never require hand-editing deployment config.

**Where it is stored.** The connections table has no column for it, so this needs one new text-array
column alongside the existing muted-tools column, added in a new SQL file in the integrations
package, plus one field on the connection detail contract and the update request. Default empty.

### 4. Per-request call ceiling

**Change:** a hard limit on integration tool calls within one user request. On exceeding it the
proxy refuses further integration calls for that request and returns an error envelope reading
"Call limit reached for this request; answer with what you have." The chat still completes and
answers; it simply stops being able to call out.

**Number:** 12 calls per request. Ben's 5-call sequence fits comfortably; a runaway loop against
a badly-behaved server does not. Counted after suppression, so repeats do not consume budget.

### 5. Response size budget

**What is actually there today.** Three separate limits exist and none of them did the job:

- The 64,000-character cap is applied on the OpenAPI path only
  (`packages/integrations/src/openapi-invoke.ts`). **The MCP call path applies no size cap at
  all** — and the whole-house dumps came over MCP.
- A third limit already exists further downstream: the chat gateway truncates every tool result at
  16,000 characters (`packages/ai/src/gateway/output-validation.ts`). So the two 20,000-character
  dumps reached the model as at most 16,000 characters each. They were cut, just far too late and
  far too generously, and with nothing telling the model it had a partial answer.

**Change:** one budget, enforced in the proxy so it covers both kinds:

- **Per response: 8,000 characters.** On exceeding, truncate the service's payload and set the
  summary to "Result truncated at 8,000 characters; ask for a narrower query to see more." The
  model is told what happened and what to do, rather than silently receiving a partial answer.
  This sits under the gateway's existing 16,000 cut, so the proxy's message-carrying truncation is
  always the one that fires for integration tools and the gateway's silent one never does. The
  gateway limit is left alone — it guards every tool in the product, not just these.
- **Per request: 24,000 characters** across all integration tool responses. On exceeding, further
  calls return the same refusal as the call ceiling.

**The fate of all three caps, stated plainly**, since "two caps where only one fires is what let
this through" has to apply to the spec's own proposal:

| Cap                                                        | What happens to it                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 64,000 characters, OpenAPI path only                       | **Retired.** With 8,000 above it, it can never fire.                                                                                                                      |
| 16,000 characters, chat gateway, every tool in the product | **Kept, untouched.** It is the product-wide backstop for tools this spec does not govern. Moving it would change every tool in the product, which the Non-Goals rule out. |
| 8,000 characters, integrations proxy, new                  | **The one that fires.** It is the only one that carries a message the model can act on, so it must sit meaningfully below the backstop.                                   |

**What the budget measures.** The 24,000-per-request budget counts what the service sent, before
the gateway's backstop trims anything. That is deliberate — the cost being controlled is the
traffic Moss pulls in, not only the part that reaches the model — but it means the number is not
"characters the model saw".

### 6. Curation without service-provided groups

**Problem:** the rule that holds tools back until the user opts in (`isGroupOptIn` in
`packages/integrations/src/curation.ts`) requires at least one tool to carry a non-empty group.
MCP discovery sets the group to empty for every tool, so the rule can never fire for an MCP
connection at any tool count. The 30-tool threshold is dead code for the MCP half of the product.
That is why all 75 tools are enabled and 28,359 characters of tool definitions ride on every chat
turn, including turns with nothing to do with the connected service.

**Change:** when a connection exceeds the 30-tool threshold and the service supplied no groups,
Moss derives groups from tool-name structure. "Longest shared prefix" is not enough on its own:
nearly every tool on the live connection starts with the same four letters naming the service, so
that rule alone produces one group of sixty and the screen is no better than a flat list. The rule
is therefore stated step by step:

1. **Split each name into segments** at upper-case boundaries and at separators (`_`, `-`, `.`).
   `HassMediaPause` becomes three segments; `todo_add_item` becomes three.
2. **Drop a leading segment shared by more than half the tools.** That segment names the service,
   not a family, so it carries no information. Repeat until the leading segment is shared by half
   or fewer.
3. **Group on the next segment.**
4. **Split any group larger than 12** by repeating steps 2 and 3 one level deeper, so a big family
   becomes sub-families rather than one long list.
5. **Sweep any group smaller than 3 into `Other`.** A group of one or two is a row, not a group.

The minimum size of 3 is the number most likely to bite, so the check is the other way round: the
real 75 tool names from the live connection are captured as a fixture, the expected grouping is
written into the test, and if the algorithm produces something unhelpful on real names the
algorithm changes, not the fixture. The earlier draft's example of a turn-on/turn-off family was
wrong on its own terms — two members is below the minimum, and those two land in `Other`.

Derivation is presentation only: it never renames a tool, and the name sent to the service is
always the discovered one.

The opt-in rule then applies uniformly: **over the threshold, nothing is enabled until the user
chooses**, whether the groups came from the service or from Moss.

**Grandfathering, with a mechanism, not a promise.** Today Ben's 75-tool connection works
_because_ the opt-in rule never fires: the enabled-tools list is empty and an empty list under the
old rule means everything is on. The moment derived groups exist, the opt-in path takes over, an
empty list means nothing is on, and the one production connection goes dark on upgrade. "A pull
request must never break production" makes this a blocker, so the spec names the mechanism:

**A one-time data step writes the currently-effective tool names into the connection's own
enabled-tools list**, for every connection that is over the threshold, has an empty enabled list,
and has no service-supplied groups. After that step the connection's enabled set is explicit rather
than implied, and every later rule reads it the same way.

The alternative — a flag marking the connection as predating grouping — was rejected because the
two behave differently the next time the user refreshes discovery: a flag would silently switch on
whatever new tools the service has added, while an explicit list leaves them off until the user
chooses. Leaving new tools off is what the opt-in rule is for.

The detail page shows a one-line notice that grouping is now available, with the derived groups
ready to narrow. Ben's connection is the only instance of this in existence and it is working
today; breaking it to satisfy a new default would be the wrong trade.

### 7. Call timing in the audit record

**Change:** add a `duration_ms` column to `app.moss_action_audit_log`, populated for **every
audited** tool call, integration or not. The gateway deliberately writes no audit row for a small
set of read-only built-in tools — a row per call there was judged noise — so those calls will never
carry a duration, and that is fine.

**This one is deliberately a gateway change, not a proxy change.** The audit table is owned by the
AI package, so the new SQL file goes in `packages/ai/sql/` with a globally unique version, and the
timing is measured and written by the gateway. That is the opposite of this spec's "the proxy is
the enforcement point" ruling, on purpose: timing is not enforcement, it is telemetry, and it is
worth more when it covers every tool rather than only these. Never an edit to an applied migration
— the runner hash-checks applied files.

**Recording a suppressed or refused call needs a second migration.** The audit table's outcome
column has a check constraint listing the allowed values, already widened once
(`packages/ai/sql/0177_audit_outcome_widen.sql`, currently success, failed, denied, cancelled,
invalid, conflict). A distinct outcome for a call Moss chose not to make means widening it again,
in a second new file in the same package, plus the gateway change that writes it. Left out of the
spec's first draft; without it the "suppressed calls are visible afterwards" promise silently fails
a constraint at run time.

This is what turns "it feels slow" into "the service answered in 50 ms and we made five calls".
The diagnosis in this spec took a live production instance and manual timing to produce; it
should take a query.

### 8. Stop rebuilding every tool on every call

**Problem found while writing this spec.** The chat gateway asks for the actor's tools by calling
the module resolver, and it does that **on every single tool call**, not once per turn
(`executableTools` in `packages/ai/src/gateway/gateway.ts`, called from the tool-listing path and
again from each call path). The integrations resolver runs inside that, so every tool call
re-reads the user's connections from the database and rebuilds all 75 tool descriptions from
scratch. Ben's five-call request did that five times.

This was not in the original diagnosis and is a second, independent cost sitting underneath the
repeated calls. It is also why the duplicate store in section 3 cannot live in a closure created
by the resolver: that closure is thrown away and recreated before the next call.

**Change:** the integrations resolver caches a user's connection rows and built tool descriptions
in memory for **30 seconds**, keyed by acting user, and drops the cached entry immediately when
that user changes a connection — adds, edits, deletes, refreshes discovery, or changes which tools
are enabled. Nothing is shared across users. A stale entry can only ever affect the user who owns
it, and only until their own next edit.

**Why 30 seconds:** it is the same number as the duplicate store in section 3, and one number is
easier to reason about than two. It only has to survive one assistant burst — the observed burst
was 13 seconds — and the drop-on-edit rule, not the clock, is what keeps a user's own changes
immediate.

**Scope note.** Only the integrations half is changed. The gateway's habit of re-resolving every
module on every call is a broader problem affecting the whole product; fixing that belongs in its
own piece of work and is recorded under future direction, not done here.

### 9. Connection reuse

**Change:** hold one MCP client per connection instead of connecting and closing on every call.
`connect()` currently runs per invocation, including a streamable-HTTP attempt with an SSE fallback
in a `catch`.

**Who closes it, and when.** Section 3 established that no request-end signal exists, so "closed at
request end" would be a promise with no trigger. The held client lives in the same store as the
duplicate memory, under the same key and the same 30 seconds of quiet, and is closed by the same
expiry sweep. A client that is mid-call is never closed underneath itself: expiry marks it and the
close happens when the call returns. If a held client is found to be broken, the next call
reconnects rather than failing — a reconnect is 8 to 52 milliseconds.

Measured cost on the live connection is 8–52 ms per call — genuinely minor, which is why this is
last. Against a remote service over TLS with an auth handshake it is plausibly several hundred
milliseconds on every call. No pooling across users, ever: the key starts with the
acting user, and a client carries that user's credential.

## Delivering this

Three pull requests, in this order. Each is small; nothing here should be dropped.

1. **The safety core** — sections 1 to 5. Knowing which tools act, the outcome envelope, duplicate
   suppression, the call ceiling, the size budget. No user-visible screen changes. This is the part
   that stops a duplicated purchase, so it goes first.
2. **Curation** — section 6, plus the connection detail page. **This one needs Ben to see the
   screen before it is built**, per the design gate: it changes an existing page and introduces an
   opt-in flow that every future large connection will meet on day one. Mockups in the spec,
   agreed, then build.
3. **Speed** — sections 7 to 9. Timing, the per-call rebuild, connection reuse. Pure performance,
   lowest risk, and section 7's timing makes the other two measurable.

Within each pull request, slices share the worktree and the pull request — slices are
session-sized, not pull-request-sized.

## Proof paths

Live proof on a real instance, recorded on the PR, per the live-path gate. Both use the existing
Home Assistant connection:

1. **The repeat is gone.** Ask chat to turn a light off. The audit log shows exactly one
   `HassTurnOff` and no `GetLiveContext` follow-up. Record the before-and-after wall-clock time
   for the same sentence — the ~13 s baseline above is the comparison.
2. **Curation works without groups.** On the 75-tool connection, the detail page shows derived
   groups rather than a flat 75-row list, and turning a group off removes exactly those tools
   from what chat can call.
3. **The tool list is not rebuilt per call.** With timing recorded (section 7), one chat request
   that makes several integration calls shows the connection read from the database once, not once
   per call.
4. **A read after an action is fresh.** Ask chat to turn a light off and then report the state of
   the lights in one sentence. The reported state is the state after the switch, not before it —
   the check that the stale-snapshot rule in section 3 actually holds on a real service.

## Error handling

- A suppressed or refused call is never surfaced to the user as a failure. It is a normal
  envelope with an explanatory `summary`; the model continues and answers.
- Truncation is never silent. Every truncated response says so in `summary`.
- The audit log records suppressed and refused calls with a distinct outcome, so a request that
  hit a ceiling is visible afterwards rather than looking like a request that simply made fewer
  calls.
- Secrets never escape: the envelope carries the service's payload and Moss's own summary, never
  credentials, headers, or the connection URL's credential parameters.

## Testing

- Unit: reading the three hints out of an MCP tool list, including a tool that carries none, and
  out of an OpenAPI operation for each method; duplicate-key canonicalization; a repeated read
  served from the store; the same repeated read run for real after an intervening successful
  action; a repeated action blocked; a repeated action allowed because the service marked it safe
  to repeat; a tool with no hints at all treated as acting; ceiling arithmetic; truncation
  boundary at exactly 8,000; group derivation over the real 75 tool names, including the
  minimum-group-size and `Other` cases.
- Unit: the cached tool list is dropped the moment the owning user edits a connection; one user's
  cached entry is never returned for another user; a stored duplicate expires after the window.
- Integration: a fake MCP server that returns an oversized payload, one that answers slowly, and
  one that annotates nothing; assert the caps fire, the envelope shape holds, a connection whose
  stored tools predate this change still behaves, and the audit row carries a duration.
- Live: the proof paths above, on the live dev instance, recorded on the PR.
- DB-touching test commands only via the `verify-gate` skill.

## Future direction (recorded, not built)

- Summarizing an oversized response with a model call instead of truncating it.
- Cross-request caching of integration reads with an explicit freshness window.
- Using the destructive hint to drive the confirm/approval gate, so a tool the service marks
  destructive asks the user before it runs.
- Re-running discovery automatically when a connection's stored tools predate the hint fields,
  rather than waiting for the user to press refresh.
- Giving tools a turn identifier, so "one request" becomes exact and section 3's 30-second window
  can be deleted.
- Resolving a user's active modules once per turn instead of once per tool call, across the whole
  product rather than only for integrations.
