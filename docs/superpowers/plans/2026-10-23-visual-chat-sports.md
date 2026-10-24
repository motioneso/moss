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
