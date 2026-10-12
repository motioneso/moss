# Plan: Trail Marker sends a window picture to the focus judge (#3067)

Status: awaiting coordinator approval. Sensitive risk tier. Base: main at
90e7f263c, including server Phase 1 from PR #3075. Branch:
feat/3067-judge-screenshot-mac. Work stays in this worktree under ~/Jarv1s.

Authority: approved spec 2026-10-05-trail-marker-judge-screenshot.md, sections 4,
5, 8 and 9; original plan's Phase 2; Ben's October 12 instruction to begin.
No feature code precedes coordinator approval of this plan.

## Comparison before build

Checked the Mac without taking any new picture. Trail Marker's application
support directory contains zero JPEG, PNG or HEIC files; its cache also contains
zero. The other usual Trail Marker support paths and Pictures/Screenshots did
not provide a saved set. Backtrack's README describes an encrypted text buffer,
not saved pictures (apps/trail-marker/README.md:43). Its specification section 5
says frames live only for one recognition call. No five-window set was found in
these bounded checks; no personal directories were searched broadly.

The comparison has NOT passed. Per the task brief, continue planning and notify
the coordinator while Ben decides. If an existing set becomes available, run
the direct path through our disposable Moss install and the old path with
tools/jev-pilot/clef_probe.py --compare. That tool calls Cloudflare directly, so
its direct timing alone cannot establish latency through Moss. Use the same
goal and picture for both paths. Keep pictures on the Mac or in a removed temp
folder. Post only five labels, correctness and timings. Ben owns the decision:
stop if the direct judge is wrong twice where the old path is right, or median
latency through Moss exceeds five seconds. Never capture Ben's screen to fill
the missing set.

## Verified seams on the base commit

| Seam               | Current implementation                                                                                    | Planned change                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sources            | Services/VisionDescriber.swift:5 under apps/trail-marker/TrailMarker has only apiKey and cli              | Add judge; never select it by default                                        |
| Preferences        | Services/PreferencesStore.swift:136 persists the source raw value                                         | Reuse storage, keep other source settings and logout cleanup                 |
| Wire context       | Services/CompanionClient.swift:106 omits the two server image fields                                      | Decode optional judgeTakesImages and judgeName; absence means unavailable    |
| Wire request       | Services/CompanionClient.swift:111 encodes description only when present                                  | Encode image and test only when present; old requests keep their fields      |
| Judge transport    | Services/CompanionClient.swift:359 calls the existing judge endpoint                                      | Reuse pairing credential and endpoint                                        |
| Context acceptance | Model/FocusMachine.swift:134 rejects stale generations                                                    | Publish judge availability only for a current accepted context               |
| Runtime context    | App/FocusRuntime.swift:508 fetches context                                                                | Refresh availability and clear it on context failure, disconnect and logout  |
| Rung 3             | App/FocusRuntime.swift:531 sends the first judge call; :572 constructs a describer; :603 sends the second | Branch only after insufficient evidence; judge source skips both describers  |
| Capture            | App/FocusRuntime.swift:579 uses the bound window and existing maximum dimension                           | Reuse identity checks, policy, JPEG encoding and cancellation checks         |
| Test               | App/FocusRuntime.swift:299 applies pause, Focus and never-watch checks; :385 retains a preview            | Judge Test fetches fresh context and requires a current block before capture |
| Picker and consent | Views/Settings/FocusPane.swift:168 and :296                                                               | Conditional third source and literal named destination                       |
| Judge schema       | packages/shared/src/companion-api.ts:527                                                                  | Optional boolean test; same request limits and response shape                |
| API dispatch       | apps/api/src/companion-routes.ts:405                                                                      | Forward test through the existing authenticated, scoped call                 |
| Judgment storage   | packages/focus-judgment/src/judgment-service.ts:216; lock and insert after model result                   | Return test result before every nudge read, lock or insert                   |
| Confidence display | packages/focus-judgment/src/choice-judgment.ts:183                                                        | Reuse the fixed reason containing percent sure; no invented confidence       |
| Server capability  | packages/module-registry/src/focus-wiring.ts:93                                                           | Already reports model name and the same image predicate as the AI layer      |
| App map            | packages/shared/src/app-map-core.ts:100 and :274                                                          | Replace Mac-not-yet wording and describe source, consent, Test and recovery  |

Swift seam paths in this table are relative to apps/trail-marker/TrailMarker.
Graph discovery located these seams; source reads verified them against this
worktree. The prior plan's :572 citation is still accurate.

## Decisions and contracts

1. Add optional test?: boolean to shared FocusJudgeRequest and FocusJudgeInput.
   Add optional image and test to the Swift request and its coding keys. Normal
   callers omit both new fields. False or absent test follows existing behavior.
2. Test reuses judge(), its owner/current-block validation, timeout, image
   refusal and model call. With test true, return judgmentId as an empty string,
   the real label and reason, and nudge false before the nudge lock. Never send
   that result into the Focus machine, remembered judgment or correction UI.
   Model activity may retain its existing metadata and image count; Test must
   not create a focus judgment or change nudge history.
3. A separate test route would make its distinct response explicit and prevent
   an empty identifier, but would duplicate request schema, routing and client
   dispatch. The flag is smaller and preserves the existing response contract.
4. FocusContext gains a custom decoder with default false for a missing image
   capability and nil for a missing name. Preserve convenient initialization
   for existing fixtures. Availability requires both true capability and a
   nonempty name. No generic model name in consent.
5. Publish judgeTakesImages and judgeName from current context. A selected judge
   source stays selected if unavailable, with a disabled selected row and the
   spec's recovery sentence. Other users see the new row only when available.
   Fetch fresh context for Test and recheck capability before its image call.
6. Rung 3 keeps the first title call. Only insufficient evidence, enabled capture,
   Screen Recording, current Focus state and an allowed identified window can
   trigger the second call. An unavailable judge skips capture. The JPEG data
   URL replaces description; never combine them. No image retry or fallback to
   another source. Unsupported or failed image calls leave insufficient evidence.
7. Keep JPEG Data, encoded request body and data URL local to the async call.
   Nothing enters lastSent, RememberedJudgment, preferences or diagnostics.
   Clear image-bearing locals and preview in all success, error and cancellation
   exits. Do not print provider exceptions or request bodies. Inspect URLSession
   configuration and use an ephemeral uncached session if needed to meet the
   brief's no-disk condition; verify the receiving library path before claiming
   this property. Do not promise physical memory erasure from Swift Data.
8. The brief requires dropping the picture immediately after the call, whereas
   spec section 4 shows a retained Test thumbnail. Follow the newer brief: show
   the preview only while the Test call is in flight, clear it on completion,
   and retain only label/reason. Coordinator approval must resolve this visible
   deviation. Existing non-judge previews keep their behavior.

## Determinism boundary

Availability, consent, errors, progress and Test formatting come from validated
context and fixed UI strings. The model has only the two existing questions:
alignment with the calendar goal and visible activity. No prompt expansion,
chat injection or model-authored configuration. Display the existing validated
label/reason; confidence comes from the existing reason, never a guessed value.

## Build order and checks

### 1. Test-only server call

Change packages/shared/src/companion-api.ts, apps/api/src/companion-routes.ts and
packages/focus-judgment/src/judgment-service.ts. Extend the existing package
service tests and tests/integration/companion-focus-image-routes.test.ts.
No migration, provider change or new dependency is required.

Prove test true makes a real model call but never invokes storage or nudge
methods; false/absent still stores normally. Prove an invalid device, another
owner's block and a stale block retain existing refusals. Test image plus
description, body limits, model failure and unsupported image remain guarded.
The no-write test must fail if the early return moves below insert.

### 2. Mac wire contracts and runtime

Change Services/VisionDescriber.swift, Services/CompanionClient.swift,
App/FocusRuntime.swift and only necessary PreferencesStore/FocusMachine seams.
Cover every source switch, including the default describer factory, without
letting judge construct an API or CLI describer. Keep the old source defaults.

Extend CompanionClientTests and Rung3DecisionTests; add JudgeSourceTests in
apps/trail-marker/TrailMarkerTests. Use injected transport/capture seams for
the real runtime orchestration, not just a parallel test helper. Assert one
title call followed by exactly one image call, zero describe calls, no image
in remembered state/defaults, and no retained test capture after completion.
Exercise success, failure, cancellation, pause during capture, permission loss,
never-watch, missing block, unknown name and stale context. Observe the image
retention assertion fail when cleanup is removed.

### 3. Settings and map

Change Views/Settings/FocusPane.swift and packages/shared/src/app-map-core.ts.
Reuse native SwiftUI controls and the agreed mockup; read the Mac design guide
before UI edits. Show the named judge, no locally stored key, and unavailable
remediation without source switching. Judge Test displays the label and the
existing confidence-bearing reason. Keep API-key and CLI text unchanged.

### 4. Proof and shipping

Add tests/uat/specs/3067-judge-screenshot-mac.uat.spec.ts for the disposable
server path using the existing UAT helpers: pair, current synthetic block,
image capability, test call with no judgment row and normal image judgment.
Add blocking rows in .claude/skills/coordinate/uat-trigger-map.tsv for changed
server and contract paths. This browser/server UAT cannot prove native capture;
record the separate real Mac proof explicitly.

Build/test in a separate clone or worktree under ~/moss-builds/judge-3067-mac
on the designated Mac. Run caffeinate first. Use a separate proof bundle id
and matching keychain namespace if needed; do not reset Ben's defaults or
keychain or replace /Applications/Trail Marker.app. Check permissions on that
isolated identity; report a blocker if they need a human grant. Start only the
branch app from its build directory. Never capture Ben's windows: exercise a
synthetic page in a disposable browser window, with Focus watching only it.

Use the private moss-proof recipe for our own disposable install, reserved
dev port and JARVIS_IMAGE_TAG=uat-judge-3067-mac. The Mac connects through the
server's tailnet address. Read Clef credentials locally without exposing them.
Never rewrite or intercept network responses. Through the real settings and
app: choose the available named judge; exercise an ambiguous title during a
synthetic current calendar block; observe capture and direct image judgment;
press Test and count unchanged focus judgment rows; switch to a non-image
judge and observe unavailable with insufficient evidence.

Check the marker image against API/worker logs, activity, focus judgments,
error rows, response bodies, Mac logs and isolated defaults. Inspect request
caching and temp files too. These are acceptance checks, not established
properties. Post only synthetic labels, timings, counts and pass/fail results;
no pictures, host addresses, credentials or personal data. If native proof is
missing, report code-complete, unverified and leave the PR draft.

## Verification commands

- On the isolated Mac checkout: xcodegen generate, then xcodebuild test -scheme
  TrailMarker -destination 'platform=macOS'; both expected exit 0. Bound log
  reads and keep full logs private outside the repository.
- Run affected non-database unit tests with the repository's Vitest setup,
  including packages/focus-judgment tests excluded by the root unit command;
  expected exit 0. Confirm current script names before launch.
- All integration and database UAT commands go through scripts/run-gate.sh.
  Run the focused image route suite first, then scripts/run-gate.sh start for
  the full foundation gate. Use scripts/run-gate.sh wait --follow with an
  event-driven background wait; expected exit 0, never pipe the gate.
- Run the new server UAT against the disposable install with existing harness
  commands, expected exit 0. Native end-to-end proof is additionally required.
- Read final-head CI checks and failures, including the macOS job. Prior PR
  #3075 evidence is context, not a substitute for this head's verification.

## Closeout

Commit by explicit path, push, post live proof (or its honest absence), and
read final CI before marking ready. PR release note: Category Added; title
Judge screenshots with your decision model; description: If your focus judge
can read pictures, Trail Marker can show it the window directly instead of
describing it first. Body says Closes #3067.

Stop every owned server and app by recorded PID, remove the disposable install,
volumes, image and Mac build folder, and release the claimed port. Leave the
worktree clean. Report ready for review to coordinator; never merge or change
the board or milestones. Stop at plan approval now, with no feature code.
