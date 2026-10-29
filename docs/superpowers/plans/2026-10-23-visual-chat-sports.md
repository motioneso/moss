# Sourced Sports replies

Task: [#3629](https://github.com/motioneso/moss/issues/3629), part of
[#3583](https://github.com/motioneso/moss/issues/3583).
Authority: the approved [spec](../specs/2026-10-23-visual-chat-replies.md) and
[handoff](../handoffs/2026-10-23-visual-chat-sports.md), including independent review,
fixes, verification, squash merge and verified fresh Weather successor.
Worktree: `~/Jarv1s/.claude/worktrees/visual-chat-sports`.

## Prerequisite and rollout boundary

The merged #3603 receipt proves its recorded cases on configured Codex economy
`gpt-5.6-luna`: 20/20 first-attempt user-data visuals, four prose controls, useful text,
saved identity/render/copy/reload and separately recorded lifecycle cases. Its private
`gpt-6-luna` case is not that model's visual matrix. It does not establish other
providers, arbitrary side chats or every lifecycle case.

Before domain rollout, run the unchanged installed 20-case matrix against the current
configured economy route; record the actual provider/model, first attempts, text,
latency and available usage. Keep unavailable/unverified routes on truthful text
fallback, and leave umbrella stage 1b unchecked while its broader matrix is incomplete.
No provider or model is hardcoded in product code.

If the required reliability, lifecycle, runtime or source boundary fails, record a
measured recommendation on #3583. Ben owns any renderer/product-scope exception;
existing authority does not waive that kill gate. Continue independent seam/source
work where possible, but do not merge or launch dependent domain rollout as accepted.

## Current seams, checked before implementation

| Capability                             | Evidence in the current tree                                                              | Consequence                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor/thread/turn capture              | `packages/module-sdk/src/index.ts:119`; `packages/chat/src/live/chat-session-turn.ts:294` | Register only against captured identity and the open turn; cancellation closes it.                                                                                                            |
| Existing snapshot ownership and bounds | `packages/chat/src/visual/turn-registry.ts:74`                                            | Reuse opaque references and bounded copies; no new durable store.                                                                                                                             |
| Existing proposal and finalization     | `packages/chat/src/visual/presentation-service.ts:68`                                     | One model proposal; validation before acceptance/save.                                                                                                                                        |
| Current catalog limitation             | `packages/shared/src/visual-chat-catalog.ts:102`                                          | Only user-data compositions exist. Public built-in domain registration is required; a Sports branch in core chat is not acceptable.                                                           |
| Lazy pinned renderer                   | `apps/web/src/chat/visual-reply.tsx:6`; `apps/web/src/chat/visual-renderer.tsx:56`        | Preserve the restricted OpenUI composition path; fixed domain components enter through the same validated catalog boundary.                                                                   |
| Browser contribution discovery         | `packages/settings-ui/src/scanner.ts:154`; `packages/module-web-sdk/src/index.ts:27`      | Extend declared public discovery for small domain contracts and lazy module-owned renderers. Do not import a backend manifest in browser code.                                                |
| Built-in manifest composition          | `packages/module-registry/src/index.ts:3350`                                              | Assemble reviewed built-in template declarations here; reject duplicate/unsupported registrations and external declarations.                                                                  |
| Read tools and host services           | `packages/module-sdk/src/index.ts:176`; `packages/chat/src/gateway-services.ts:259`       | A module-owned read tool can register a normalized snapshot through an injected public capability. The model cannot supply that snapshot.                                                     |
| Public data fetch/cache                | `packages/datasets/src/client.ts:117`; `packages/sports/src/manifest.ts:793`              | Add a declared dataset and reuse the pinned source adapter, cache, timeouts and degradation.                                                                                                  |
| Stable team identity                   | `packages/shared/src/sports-api.ts:4`; `packages/sports/src/followed-groups.ts:26`        | Identity includes provider, sport and permanent team ID. Names/abbreviations are search hints only.                                                                                           |
| Existing schedule is insufficient      | `packages/sports/src/source/espn-source.ts:488`                                           | It merges separate result/fixture reads, can hide failure of one half, and loses official completion/shootout/aggregate detail. Use a dedicated bounded results dataset.                      |
| Read-only route policy                 | `packages/sports/src/manifest.ts:309`                                                     | Overview stays blocked. Add a separate read route and tool; no follow, sync, source-authority or preference writes.                                                                           |
| Source preferences                     | `packages/sports/src/source/espn-coverage-repository.ts:14`                               | These are ESPN **headline** coverage settings. Do not silently reinterpret them as blanket score-source consent. Verify applicable source/AI policy at the existing gateway and route guards. |
| Real-browser harness                   | `tests/uat/provisioned-run.ts:29`; `tests/uat/specs/3600-visual-chat-real.uat.spec.ts:78` | Disposable installed app and actual configured engine, zero retries and no rewritten app responses.                                                                                           |

## Decisions and bounded contracts

The model has exactly two jobs: decide whether a visual helps and arrange/select registered
components; write concise interpretation and propose normal conversational follow-ups.
Host/module code owns facts, team/event IDs, completion, coverage, timestamps, assets,
fallback text and save status. Guidance stays below 150 words plus generated contracts.
Modules never inject chat turns. There are no write controls in this slice.

1. **Sports read**, owned by `packages/sports/src/results/` and public shared Sports
   contracts. Provide a latest-result read with bounded name/context resolution and
   explicit stable identity inputs. Resolve known follows first; a competition/roster
   supplies any explicit team ID. Multiple men's/women's candidates require a normal
   clarification. A partial search is not evidence that a unique team exists.
2. Fetch recent completed results for the resolved team across the explicitly covered
   competitions in a 90-day window. A dedicated `results` dataset carries official
   provider status, stable event IDs, home/away sides, nullable scores and distinct
   extra-time/shootout/aggregate detail. Deduplicate by provider/sport/event identity,
   filter invalid dates and non-results, then choose the newest kickoff. Preserve
   failed/missing competition coverage; incomplete coverage says **Latest available
   result**. An empty window is an empty response. Never substitute an upcoming match.
3. Add a Sports-owned public GET and assistant read tool over the same reader. The
   tool uses the gateway's actor-scoped database and injected presentation capability.
   Only a successful authorized result registers a source snapshot. Denied, disabled,
   ambiguous and empty cases keep useful text. Reads do not change follows, source
   settings or source authority. No new credential or outbound host is required.
4. **Public template seam**, owned by `packages/module-sdk`, `packages/shared` and
   `packages/module-registry`: immutable reviewed built-in template declarations with
   kind/snapshot identity and module-owned validation. Compose the boot catalog from
   declarations, including duplicate checks. Stored/save/render validation resolves
   this same contract; unavailable templates retain readable fallback. Existing
   `moss.user-data.1` compositions remain compatible. Domain blocks carry references,
   never model-authored scores, URLs, source labels or renderer code.
5. **Sports normalizer/card**, owned by `packages/sports/src/results/` and its public
   browser contribution. Keep only display-required facts, source, retrieval time,
   covered competitions/window and permitted crests tied to the exact side identities.
   Match results render a module-owned ordinary React composition through the public
   catalog; no Sports imports or name branches in core chat. Use shared Card, Badge,
   SectionHead and Note. Missing general score/identity primitives belong in
   `packages/ui`. Styling uses semantic tokens; module CSS is layout only. Team names
   remain readable when a missing/blocked/failed crest falls back to initials.
6. Update the Sports app-map features/errors/remediations in the same PR. State actual
   source availability, ambiguity, coverage limitations and text fallback. Historical
   snapshots never refetch; ordinary follow-up reads create new snapshots. Preserve
   existing history/archive/export/private handling and text-only destinations.

Open evidence owners: this implementer verifies provider date-range/completion payloads,
applicable source-disable semantics, the current installed economy model and exact
browser registration behavior before claiming support. Unsupported fields remain absent;
unsupported source coverage remains explicit. These are observations, not permission
to fabricate detail or weaken acceptance.

## Behavior and installed acceptance

- Reader/provider tests distinguish a newer cup result from an older league result;
  stable duplicate IDs, reversed home/away, upcoming/live/postponed/cancelled/abandoned
  events, official abandoned results, draws, extra time, shootouts, aggregates, null
  scores, absent scorers, failed competition and empty window. Identity cases cover
  colliding names/abbreviations and men's/women's ambiguity without writes.
- Host/catalog tests reject foreign turn/actor/thread references, forged facts/assets,
  malformed/unknown templates and invalid/oversized envelopes. Assert that a read alone
  does not publish a visual, and Stop/switch/failure cannot attach a late sourced result.
  Observe claimed security tests failing with the relevant guard removed, then restore it.
- Browser/component tests prove correct names/logos/score/source, accessible asset failure,
  null/draw/shootout/partial states, immutable reload and 390px/drawer bounds. Use text
  and executable assertions, in accordance with the repository live-path rule.
- Installed UAT: owner login and real Settings/module path, real configured economy
  chat, then an ordinary latest-Liverpool question without a graphic request. Assert
  authorized read, issued reference, natural proposal, saved reply, exact source facts,
  loaded real crests, sources, copy and reload. No intercepted/replayed app responses.
- Record 20 fixed first-attempt domain prompts on each rollout configuration, at least
  19 intended visuals and useful text for every case; prose/text-only controls and a
  novel user-data composition remain required. Reuse unchanged #3603 lifecycle/runtime
  evidence only with its explicit scope. Report measured latency, prompt/output overhead
  and incremental built-app bytes; no unsupported provider/surface claim.

## Delivery and chain

Commit this plan before product code; retain inherited handoff commit `de34764ca` in
the product PR. Commit/push explicit paths and use the PR skill and release-note template.
Run scoped meaningful tests and static checks (expected exit 0), then the full local
gate only via `scripts/run-gate.sh start` and detached sentinel `wait --follow`.
No bare database tests or piped gates. Observe exit 0, obtain fresh green CI and record
installed evidence. Commission independent Standards and Spec reviews of the complete
diff at the exact final SHA, fix every actionable finding and re-review changed areas.
Merge only after all required evidence matches that SHA, using squash and match-head.

After verified merge, update #3629/#3583 truthfully; commit/push the Weather handoff on
the successor base, launch an isolated named fresh session and verify its Start section
is executing. Carry the full approved remaining roadmap and review/fix/verify/merge/next
chain forward. Clean owned resources and release claimed ports before this session ends.

## Acceptance checkpoint and integration repair

Candidate `2901e1839` genuinely failed the installed Sports matrix on configured
Codex economy `gpt-6-luna`: 0/20 first-attempt cards, with useful sourced prose in
20/20 replies. No renderer/reload/phone claim follows from that run. The failure
and measured recommendation remain recorded on #3583 and PR #3633. Ben decided:
**Repair integration and retain the gate.** The renderer and 19/20 threshold stay.

An ordinary-question diagnostic using the acceptance setup called
`sports.latestResult` and returned the correct result, but never called
`chat.present`. The source-tool/registration/presentation seam passes a direct
behavioral test. The trusted turn guidance still described only user-data grammar
and prohibited all other syntax; the source proposal's imperative description was
inside an untrusted tool result. Repair that contract generically: the trusted host
explains how to use current-turn source proposal data, scopes the user-data grammar
to its catalog, and leaves visual selection to the model. Remove the imperative
source description. Never relax tool-result instruction defenses or host validation.
The live model repro is the regression seam for this selection behavior; a string
assertion over guidance would not establish it. Re-run the original fixed matrix
and the unchanged user-data matrix on the actual rollout model before acceptance.

The stopped full local gate also exposed missing results-route classification and
approval fixtures. Add those cases and make the approval fixture check GET query
fields, matching the route catalog's existing request-schema semantics.

The repaired candidate's first matrix turn saved the source-bound card, then failed
its real browser render assertion: the slot remained at Preparing visual. A focused
React regression reproduced that state after resolving the module loader. Creating
`lazy()` inside the component's `useMemo` gave it a new identity when React retried
an initial suspended mount. Hoist the lazy domain loader to module scope so it
survives suspension and subsequent updates reuse the loaded contribution. The
regression was observed red before this fix and green afterward. Keep the first
failed matrix/render run in the evidence; evaluate a new fixed matrix, not retries.

Candidate `dadcb3a5f` then rendered the real card. One run stopped at failed crest
loads; subsequent app-origin and actual-card diagnostics loaded both real assets.
A separately identified complete matrix on discovered economy `gpt-6-luna` passed
crests, saved snapshot/reload and 390px checks but failed selection: **17/20** cards.
Cases 4, 8 and 13 were prose. This remains failed acceptance, even though a separate
instrumented diagnostic produced cards for all 20. Diagnostics never replace the
required matrix or authorize repeating unchanged evaluations until one passes.

Before any further selection repair, inspect per-turn read/presentation activity
on a missing-card diagnostic. Only a verified omitted current read would support
fresh-read guidance; a read followed by prose is a different failure. Keep the
original fixed prompts, order, conversation and 19/20 threshold. Any trusted
guidance change also repeats generic composition and prose-control acceptance.

The prose harness incorrectly rejected the concise correct answer “Liverpool beat
Brentford 2–1.” solely on character count. Replace that arbitrary cutoff with bounded
checks for both team names and an actual score pair, keeping refusal/DSL rejection.
Negative cases reject unrelated teams, wrong scores and misleading digit substrings.
Exact home/away alignment is still asserted against the source-bound card; these
prose checks are not a general language parser. This correction does not turn the
17/20 visual failure into a pass.

CI also exposed two stale fixture expectations: the explicit route total must include
the new read, and Finance's exact expected version must match its required artifact
bump. Preserve exhaustive route rows and recovery assertions. An unchanged pattern
queue timing test failed under concurrent local work; its isolated 26-test file passed.
The interrupted full gate has no passing verdict and must be rerun on the final head.

A diagnostic matching the acceptance's first-card phone/reload sequence reproduced
a prose-only second turn. Its saved activity contains `sports.latestResult` and a
successful result, but no `chat.present`. By contrast, an uninterrupted diagnostic
produced 40/40 read/proposal pairs. Neither run is acceptance. The observed miss does
not justify fresh-read guidance: it already made that read. The generic instruction
“simple answers stay prose” conflates concise text with the absence of useful visual
structure. Clarify that related identities, values, status and sources can justify
a card alongside concise prose, while retaining model choice and text-only priority.
Keep guidance below 150 words, without module branches or forced presentation. Repeat
the original Sports matrix including reload, the generic matrix and prose controls.
The clean `d58183e92` gate was stopped with exit 143 before this change; rerun on the
new final head. Independent review must cover that exact head too.

The `19d09a768` matrix still failed: 0/20 cards and 20/20 useful prose. The
unchanged generic matrix passed 20/20 visuals, four prose controls and all four
browser tests. Logging-only diagnostics confirmed successful Sports registration
and identical 111-tool catalog hashes before/after reload, with the visual-choice,
matching-read and proposal-data guidance present. No missing-catalog defect was
established. Selection remained inconsistent, including web tools instead of Sports.

Under Ben's repair-and-retain-gate direction, one bounded temporary-image prompt
experiment changed the generic default to **prefer a matching source card for a
result with related identities, values, status or provenance**. It preserved prose
when a visual adds no structure/context, explicit text-only priority, current-turn
binding and host validation. Eight original prompts with first-card reload produced
eight cards; that diagnostic is not acceptance. Adopt this bounded preference for
one new candidate, then evaluate the original Sports and generic matrices once.
Do not repeat unchanged evaluations until one passes. If this candidate fails and
no concrete integration defect emerges, return the measured result for Ben's next
decision instead of continuing wording variants. Keep the renderer and 19/20 gate.

The `19d09a768` full gate also reported Workshop paging and pattern-worker budget
failures under concurrent local work. The unchanged Workshop file passed 18/18 in
isolation. The gate was stopped with exit 143 for the new candidate; it has no
passing verdict. Run the final full gate after live stacks finish, preserving all
assertions, budgets and production guards. Review the final exact head afresh.

The bounded preference candidate `fabc4133dc4ff9cc2ae96bae838aab98e91d0777`
failed its original fixed Sports matrix: **14/20 cards and 14/20 useful answers**,
required at least 19 cards and all useful answers. Zero retries; discovered eligible
Codex economy `gpt-6-luna`; no intercepted app responses. Saved tool activity for
the first six turns contains only `web_search`; those replies report unsuccessful
searches. Turn seven resumes `sports.latestResult` and `chat.present`, followed by
fourteen correct cards. The independent public read succeeded before the matrix.
This establishes unreliable tool selection, not an unavailable Sports source.
It does not establish a new catalog/registration defect or authorize another prompt
variant. The initial eight-card diagnostic remains supporting evidence only.

The run passed exact source-bound facts, real crests, immutable snapshot/reload and
390px bounds. Sports prose controls and novel composition were not reached because
the matrix failed. Sports turn latency: median 4,738 ms, p95 15,310 ms, range
3,648–24,325 ms; saved visual envelopes were 1,256 bytes, prose 52–255 bytes.
The separate generic matrix produced 20/20 visuals, four prose controls and useful
text in all 24 replies. Its full browser suite exited 1: three of four tests passed,
including copy/reload, missed-completion recovery and private End/reload. The
Stop/switch/engine-failure test failed before those checks when its warm-up reply
contained no visual. That lifecycle acceptance is unverified on this candidate.
Both independent code reviews approve the tested exact product head, with zero
findings; that approval does not pass acceptance. No final full local gate passed.

Recommendation: retain the renderer and 19/20 gate, keep merge and Weather blocked,
and investigate a bounded source-tool routing repair as a distinct design decision.
There is no evidence supporting more presentation wording variants or repeated
unchanged acceptance runs. Obtain Ben's next decision before dependent rollout;
continue only independent verification and evidence preservation while it is pending.

Ben's next decision on 2026-10-24: **Investigate and repair routing**, retaining
model choice, the renderer and the 19/20 gate. This authorizes a bounded source-tool
routing investigation/repair, not repeated presentation-wording variants or a
threshold waiver. First inspect the trusted routing contract and actual first-turn
tool availability. Preserve the failed candidate and generic lifecycle limitation.
Commit the evidence-backed routing repair plan before changing production code.

## Bounded source-routing repair plan

Current seams: `packages/chat/src/live/runtime.ts:98` supplies trusted tool routing
on every surface through `composeMossPersona` at line 137. It prefers domain tools
for Moss data/actions but separately directs public-web lookups to `web.search`.
`packages/sports/src/results/tool.ts:58` already describes the available completed-
result domain read. The failed installed activity shows web-only selections despite
a successful public Sports read; prior menu diagnostics include both tools with
unchanged catalog hashes. This is a gap in routing precedence for public facts,
not evidence for missing registration or a reason to force a visual.

Change only `MOSS_PERSONA_TOOL_GUIDANCE` in `packages/chat/src/live/runtime.ts`:
honor an explicitly requested source; otherwise prefer an available matching domain
read, including public facts, before general web research. Keep the web-search-only
native-tool restriction, descriptive queries, search-before-page-read, ToolSearch
recovery and outside-content defenses. Keep the whole routing block below 150 words.
Do not change Sports facts, source policy, presentation guidance, renderer, tool
availability, provider/model selection or acceptance prompts/threshold. Existing
Sports app-map declarations in this PR still describe the same public read/card.

A four-prompt real installed diagnostic captures saved tool activity before/after
this single routing change, using the same module/follow/public-read setup and
first-reply reload. It is a hypothesis test, not acceptance. Do not add lexical
prompt-substring tests: the existing composed-persona tests verify both surfaces;
installed first-attempt reads/cards are the behavioral signal. Run the existing
persona/host/prose suites and root static checks. If the bounded diagnostic supports
the change, commit/push it, run the original Sports/generic matrices once on that
candidate, then complete exact-head independent review, isolated full gate and CI.
Preserve any failed diagnostics/runs. If reliability still fails without a concrete
remaining defect, record the measured recommendation and actual decision rather
than start further prompt variants. Renderer and 19/20 gate remain unchanged.

The bounded before/after diagnostic completed: baseline four turns gave one Sports
read without presentation, followed by three unsuccessful web-read/search routes;
zero cards. With only the source-routing change, all four turns called the Sports
read plus `chat.present` and saved cards, including after reload. The diagnostic
reload was after the first reply even in the cardless baseline; it is not the
acceptance harness's conditional first-card reload. No retry or passing acceptance
claim follows. Adopt the bounded routing repair and evaluate the original Sports
and generic suites once. Routing guidance is 136 words; presentation guidance and
all source/presentation guards remain unchanged. Persona/prose tests passed 37/37
and host/reference/proposal/lifecycle tests passed 87/87. The UAT literal-parsing
check also confirmed the lifecycle/novel-composition fixtures provide their actual
structured fields; no harness-format change is justified or made.
