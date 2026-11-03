# Front door, slices 1 to 3: implementation plan

- **Spec:** `docs/superpowers/specs/2026-10-31-front-door-decision-model-design.md` (approved 2026-10-31).
- **Task issue:** #3925. Every slice PR says `Part of #3925`.
- **Scope:** Main chat only. Slices 1 (reach), 2 (activity line and record), 3 (per-account off switch plus admin gate).
- **Out of scope:** other chat surfaces, news and sports sorting (R1 to R3), model-written replies. Each gets its own plan after slice 3 ships.
- **Plan style:** decisions, signatures and test cases. No function bodies.

## 1. Seams check

Each row is a capability the plan relies on, proved against the tree at `origin/main` (e90e4e832).

| Capability                                                                                                           | Evidence                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The gate runs before the engine launch and skips it when it returns a turn                                           | `packages/chat/src/live/chat-session-turn.ts:54` (import), `:206` (call)                                        |
| Gate attempt order: thread read, mode read, non-`on` returns, private chat returns, then evaluate                    | `packages/chat/src/live/classifier-gate-lifecycle.ts:62-119`                                                    |
| Mode is read per actor under a data context                                                                          | `packages/chat/src/live/classifier-gate-mode.ts` (`createGateModeReader`)                                       |
| Gate setting key is `CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY` in `@moss/settings`                                       | `classifier-gate-mode.ts:2`                                                                                     |
| Per-argument plan, eligibility check and the "unfilled optional" rule that blocks non-read tools                     | `classifier-gate-arguments.ts:63-110` (`planArguments`, `gateEligibilityProblem`)                               |
| Candidate-list arguments are loaded through a tool hook; a throw or invalid list stops with `candidates_unavailable` | `classifier-gate.ts:609-616`; hook at `classifier-gate-wiring.ts:211-231`                                       |
| Tool risk floor                                                                                                      | `classifier-gate-wiring.ts:90-96` (`gateRisk`)                                                                  |
| Bars and version                                                                                                     | `classifier-gate-arguments.ts:213-222` (`THRESHOLD_VERSION`, `meetsConfidenceBar`, `meetsLead`)                 |
| Fixed reply fill returns null on a missing value                                                                     | `classifier-gate-arguments.ts:236` (`renderReplyTemplate`)                                                      |
| A handled turn can carry activity records                                                                            | `classifier-gate-lifecycle.ts:77, 217` (`HandledTurnOptions["activityRecords"]`)                                |
| Activity lines expose `kind`, `modelName`, `outcome`                                                                 | `packages/shared/src/ai-activity-lines-api.ts:36-43, 101-107`                                                   |
| An owner-only per-user key and value store with row-level security already exists                                    | `packages/structured-state/sql/0031_structured_state.sql:127-160`; port at `packages/db/src/data-context.ts:42` |
| Settings routes already read and write per-user keys through that port                                               | `packages/settings/src/themes-routes.ts:54-66`, `preferences-port.ts`                                           |
| Shadow table and retention migrations exist                                                                          | `packages/chat/src/manifest.ts:86-89` (`0251`, `0255`, `0271`)                                                  |
| App map text for the Classifier row                                                                                  | `packages/shared/src/app-map-core.ts:364-390`                                                                   |
| App map feature entry for the gate setting                                                                           | `packages/ai/src/manifest.ts:279` (`ai.classifier_gate_setting`)                                                |

**Decision from the seams check.** The per-account switch needs no migration. It is one key in the existing owner-only preferences store, whose policies already limit all four operations to the owner (`0031_structured_state.sql:140-160`). This removes migration numbering risk (see the 0214 collision memory).

**Open questions (named owner, not steps).**

| #   | Question                                                                                                                                                                                          | Owner                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q1  | Which Home Assistant tool declares the lights, and which exact parameter is dropped in preparation? The spec says preparation dropped the target arguments, but this plan did not trace the hook. | Slice 1 builder, task 1.1 |
| Q2  | How does a Home Assistant entity expose its type (domain such as `light`, `lock`, `cover`)? The lock filter depends on a reliable type field on each candidate.                                   | Slice 1 builder, task 1.1 |
| Q3  | Where is `app.preferences` deleted on account removal? The `ON DELETE CASCADE` on `owner_user_id` should cover it, but test 3.4 must prove it.                                                    | Slice 3 builder           |
| Q4  | Which file renders the user's own settings page, and which section holds an AI toggle?                                                                                                            | Slice 3 builder, task 3.1 |

If task 1.1 answers Q1 or Q2 in a way that needs a new module hook, the builder stops and reports to the planner. It does not widen scope on its own.

## 2. Determinism boundary

- The decision model has two jobs only. It picks the area and tool, then picks argument values from lists the system supplies. It writes nothing a user reads.
- The reply is a set sentence from the tool declaration, or "Done.". It renders from the tool result, never from model output.
- The activity line renders from the decision record (model, tool, time). No model text goes into it.
- Prompt guidance stays under 150 words. This plan adds no prompt text, so the budget is unchanged.
- A lock, door or garage target is removed by code when the list is built. The model is never asked to avoid them.

## 3. Slice 1: reach

**Goal.** The gate offers Home Assistant lights and switches and fills their arguments, and never offers a lock, door or garage target.

**Decisions.**

1. Candidate-list arguments survive preparation. The device list comes from the tool's candidate hook (`classifier-gate-wiring.ts:211`), so the fix is in the preparation step that currently drops the argument. Task 1.1 finds it (Q1).
2. An optional argument the gate does not fill is marked deliberately blank in the plan, and `gateEligibilityProblem` accepts "filled or deliberately blank" (`classifier-gate-arguments.ts:84-88`). Declared by the tool through its classifier declaration, never guessed by the gate.
3. The lock filter lives where the candidate list is built, not where the model answers. It is an allow-list of device types for on/off tools (lights, switches, fans), not a deny-list. A device with no type is left out. Allow-list means a new dangerous type stays hidden until someone adds it.
4. The filter applies to every on/off style tool the gate offers, not only Home Assistant.
5. No change to `THRESHOLD_VERSION`. Bars stay as they are.
6. A "report that ignores tool-list loading" (spec section 13) is a dry-run report. It lists which tools are eligible and why each excluded tool is excluded. It reads the registered tools directly and does not depend on the live tool-list call.

**Tasks.**

| Task | What                                                                                                     | Files                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1.1  | Trace why the lights tool is not offered. Record the answer to Q1 and Q2 in the PR body. No code change. | `classifier-gate-wiring.ts`, the Home Assistant tool manifest                                      |
| 1.2  | Keep candidate-list arguments through preparation                                                        | per 1.1                                                                                            |
| 1.3  | Accept "deliberately blank" optional arguments in eligibility                                            | `classifier-gate-arguments.ts`                                                                     |
| 1.4  | Allow-list filter for on/off candidate lists                                                             | new `packages/chat/src/live/classifier-gate-device-filter.ts`, called from the candidate hook path |
| 1.5  | Dry-run eligibility report script                                                                        | `scripts/front-door-eligibility-report.ts`                                                         |
| 1.6  | App map and manifest text                                                                                | section 6 below                                                                                    |

**Signatures (contracts).**

```ts
// classifier-gate-device-filter.ts
export type OnOffDeviceType = "light" | "switch" | "fan";
export function filterOnOffCandidates(
  candidates: readonly ClassifierCandidate[]
): readonly ClassifierCandidate[];

// classifier-gate-arguments.ts: the declaration gains one optional marker
// classifier.arguments[name].kind: "enum" | "candidates" | "extract" | "blank"
```

**Tests (behaviour, and why each fails on a broken build).**

| #   | Case                                                                                                                                                     | Fails when                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1.a | A device list holding a light, a lock, a door and a garage opener returns only the light                                                                 | The filter is dropped or turned into a deny-list          |
| 1.b | A device with no type is excluded                                                                                                                        | The filter defaults unknown types to allowed              |
| 1.c | A new unknown type ("valve") is excluded                                                                                                                 | The filter is a deny-list                                 |
| 1.d | A write tool with a candidate list plus one deliberately blank optional argument is eligible                                                             | Eligibility still rejects it as `unfilled_optional`       |
| 1.e | A write tool with an optional argument that is neither filled nor marked blank is still ineligible                                                       | The new marker loosens the rule for everything            |
| 1.f | A tool sorted destructive never reaches `handle` at confidence 1.0 (spec test 3)                                                                         | `gateRisk` is bypassed                                    |
| 1.g | Through the real gate with a stand-in device list, "turn off the kitchen lights" picks the light, and a stand-in list holding only a lock offers nothing | The filter runs after the model answers instead of before |

**Ends with.** The dry-run report lists the lights tool as eligible, with a stand-in list that contains a lock and the lock absent from the offered options.

**PR must show.**

- The answer to Q1 and Q2 in plain words.
- Output of the eligibility report before and after, with the exit code.
- Test output for 1.a to 1.g, run scoped, with the exit code.
- Proof that tests 1.a and 1.g fail with the filter removed (run once with the filter stubbed to pass everything, paste the failing output).
- A grep result showing a production caller of `filterOnOffCandidates`.
- `Release note: Category: N/A`.

**Live proof for slice 1.** Dry-run only, because the gate is still not On. On a dev instance with the real Home Assistant connection, run the eligibility report and send "turn off the kitchen lights" with the gate in Watch only. Show the decision record naming the lights tool and a filled device. Confirm the light did not change, since Watch only never executes.

## 3a. Slice 1 as built (supersedes the hard lock filter above)

Ben ruled on 2026-11-02 that the lock, door and garage exclusion is configurable, not a hard never.

- **Default off.** Without the setting, a tool that changes things is offered only lights, switches and fans from a device list. Unknown device kinds are always dropped.
- **Per-account opt-in.** `frontDoorGuardedDevices` is a boolean inside the existing owner-only chat settings (`chat.settings.v1`, `GET/PUT /api/chat/settings`). No migration. When on, `lock` and `cover` devices are also offered.
- **Only the owner sets it.** The route acts as the caller; the chat manifest already blocks the assistant from the PUT route. An admin has no path to another person's value.
- **Fails closed.** A missing port or a failed settings read means off. The value is read once per attempt, for the attempt's own actor.
- **A save that omits the field keeps the stored value**, so the response-style control cannot switch it off or on by accident.
- **The control and its wording belong to slice 3**, in the same settings section as the off switch. Slice 1 ships the stored field and the filter only.
- **Opt-in makes the devices eligible, nothing more.** Running a lock without a card still depends on the gateway and the tool's own risk class. A tool sorted Sensitive still escalates until the scan work's Run without asking setting exists.

Findings from task 1.1: Q1, lights are not offered because automatic preparation never builds a device list and drops optional arguments. The automatic device-list wiring is tracked in issue 3953. Q2, candidates carry only an id and a label, so the id's domain prefix (`light.`, `lock.`) is the only type signal. A list with no device-shaped ids passes unchanged. Task 1.5 (the report script) is dropped.

Live proof for slice 1 shows a lock refused by default and offered after the account opts in.

## 4. Slice 2: activity line and record

**Goal.** Every handled turn writes one activity line naming the deciding model, the tool and the time taken. Every gated message writes a decision record with verdict, confidence, lead and reason.

**Decisions.**

1. The line uses the existing activity-line fields (`ai-activity-lines-api.ts:36-43`). No new endpoint and no new field. `kind` takes a new value for a handled turn. Task 2.1 confirms that `kind` is an open string (it is typed `string` at `:104`).
2. The line is built from the decision record in code. The model name comes from the classifier configuration the gate already holds, not from any model output.
3. The line is attached through the existing `activityRecords` option on the handled turn (`classifier-gate-lifecycle.ts:77, 217`), so it is saved with the turn and survives a storage failure the same way the reply does.
4. The decision record gains verdict and reason code columns only if the shadow table lacks them. Task 2.1 checks `0251` to `0271` first. If a column is needed, the migration goes in `packages/chat/sql/` as the next free number at build time, checked against `origin/main` right before the PR opens. No edit to any applied file.
5. Escalated messages write a record too. They write no activity line, because nothing was handled.
6. The monitoring script reads the record and activity lines. It prints handled share, median time, and every handled non-read action. It is for the admin and Moss, not a gate.

**Tasks.**

| Task | What                                                                             | Files                                                                           |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 2.1  | Read the shadow table schema and the activity record type. List the gap, if any. | `packages/chat/sql/0251..0271`, `classifier-gate-shadow.ts`                     |
| 2.2  | Build the handled-turn activity record from the outcome                          | `classifier-gate-lifecycle.ts` (`persistGateOutcome`) or a new helper beside it |
| 2.3  | Write verdict, confidence, lead and reason for every gated message               | `classifier-gate-shadow.ts`, plus a migration only if 2.1 finds a gap           |
| 2.4  | Monitoring script                                                                | `scripts/front-door-monitor.ts`                                                 |
| 2.5  | App map and manifest text                                                        | section 6 below                                                                 |

**Signatures (contracts).**

```ts
// New helper, exact home decided in 2.2
export function handledTurnActivityRecord(input: {
  readonly modelName: string;
  readonly toolName: string;
  readonly latencyMs: number;
  readonly outcome: "handled" | "failed";
}): ActivityRecordInput;
```

**Tests.**

| #   | Case                                                                                                                                                                       | Fails when                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2.a | A handled turn through the real chat route with a stand-in decision service skips the engine launch, and the activity list names the model, tool and a time (spec test 10) | The line is built but never attached, or attached to a different turn |
| 2.b | An escalated message writes a record with a reason and writes no activity line                                                                                             | Escalation writes a handled line                                      |
| 2.c | The record holds verdict, confidence, lead and reason for handled, escalated and declined-for-low-confidence                                                               | A column is never written                                             |
| 2.d | The activity line for user A is not visible to user B or to an admin through the activity endpoint                                                                         | Owner scoping is lost                                                 |
| 2.e | The handled-turn line contains no text from model output (feed a model name with markup; the line shows the configured name)                                               | Model-supplied text reaches the line                                  |
| 2.f | Failure table rows from spec section 7: one test per row; escalate rows assert the engine receives the original message, "stops" rows assert it does not                   | A row falls through the wrong way                                     |
| 2.g | The fixed reply: a tool with a sentence shows it, a tool without shows "Done." (spec test 6)                                                                               | Model text can reach the user                                         |

**Ends with.** Test 2.a passes, and the monitoring script prints its numbers against the dev database, exit code 0.

**PR must show.**

- The 2.1 gap finding in plain words, and the migration number if one was added, with a note that the number was rechecked against `origin/main`.
- Test output for 2.a to 2.g, scoped, with the exit code.
- A grep result showing a production caller of `handledTurnActivityRecord`.
- The monitoring script's output and exit code, unpiped.
- `Release note: Category: N/A`, since the gate is not On for anyone yet.

**Live proof for slice 2.** Dev instance, gate On in a scratch setting (see section 5 for the sign-in and model choice). Send "turn off the kitchen lights" through the chat UI. Open the activity history screen and show the line with model, tool and time. Send a message the gate cannot do and show the thinking model answered and no handled line exists. No screenshots of full pages (crop only), no rewritten network responses.

## 5. Slice 3: per-account off switch and admin gate

**Goal.** Each signed-in user can turn the front door off for themselves, privately. After the live proof, the admin sets the gate to On for Main chat.

**Decisions.**

1. The switch is one key, `chat.front_door_disabled`, in the existing owner-only preferences store. The value is a boolean. Missing means the front door is available.
2. The switch is off-only by design: it can disable, and clearing it re-enables. There is no "force on" for a person.
3. The gate reads the switch after the admin mode check and the private-chat check, and before any decision-model call. When the switch is set, `tryGatedTurn` returns no result and writes no record (same exit as a private chat, `classifier-gate-lifecycle.ts:102`).
4. The switch is read through the same scoped data context as the actor, so the read cannot return another user's row. A read failure behaves as "switch set". Chat must not break, and the safe direction is no front door.
5. Reading and writing the switch happens only through routes that use the signed-in actor. No route accepts a user id. There is no admin route and no tool that touches it.
6. Moss's own tools must not write this key. If an assistant tool for general preferences exists, task 3.2 checks it cannot reach `chat.front_door_disabled`.
7. Account deletion removes the key through `ON DELETE CASCADE` (Q3, proved by test 3.d).
8. The admin gate setting is unchanged. It is the existing Off, Watch only, On control. The change in this slice is only its help line and the app map.
9. Screen: a plain toggle on the user's own settings page in the existing conventions, with the wording "Let the fast model handle simple requests". The spec says it is shown to Ben in the build PR and does not block the build. The builder uses `@moss/ui` primitives and the `design-system` skill. No new layout, no explanatory line under it (screen copy rule).

**Tasks.**

| Task | What                                                                      | Files                                                                                   |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 3.1  | Find the user's own settings page and the shared settings contract (Q4)   | `packages/settings-ui`, `packages/shared/src`                                           |
| 3.2  | Shared contract and route: get and set the switch for the signed-in actor | `packages/shared/src/chat-api.ts` (or a settings file per 3.1), chat or settings routes |
| 3.3  | Gate check in `tryGatedTurn`                                              | `classifier-gate-lifecycle.ts`, a small reader beside `classifier-gate-mode.ts`         |
| 3.4  | Settings page toggle                                                      | per 3.1                                                                                 |
| 3.5  | Route declared in the owning manifest (a route must be declared)          | `packages/chat/src/manifest.ts` or settings manifest                                    |
| 3.6  | Help-line sentence on the admin Classifier row                            | `packages/ai` settings UI and app map                                                   |
| 3.7  | App map and manifest text                                                 | section 6 below                                                                         |

**Signatures (contracts).**

```ts
// New reader beside classifier-gate-mode.ts
export function createFrontDoorSwitchReader(
  dataContext: Pick<DataContextRunner, "withDataContext">,
  preferences: PreferencesPort
): (actorUserId: string) => Promise<{ readonly disabled: boolean }>;

// Shared contract
export type FrontDoorSwitchDto = { readonly disabled: boolean };
// GET and PUT /api/chat/front-door-switch, actor only, no user id in path or body
```

**Tests.**

| #   | Case                                                                                                                                                          | Fails when                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 3.a | User A has the switch set; user B does not. Same instance, gate On. A gets no decision-model call, no record and no handled turn. B is handled (spec test 11) | The check is missing or reads the wrong user                     |
| 3.b | An admin cannot read or write user A's switch through any route (spec test 12). The attempt returns not found or the admin's own value                        | A route takes a user id, or the policy allows admin              |
| 3.c | Setting the admin gate to Off then On leaves user A's switch unchanged                                                                                        | The admin setting overwrites the personal switch                 |
| 3.d | Deleting user A removes the key                                                                                                                               | The cascade is not in place                                      |
| 3.e | A read failure on the switch means no front door for that turn and chat still answers                                                                         | A failure breaks chat or lets the front door run                 |
| 3.f | Row-level security: a direct query as user B's context for A's key returns zero rows                                                                          | The policy is broken (run against the real database, not a stub) |
| 3.g | The assistant's general preference tools, if any, reject this key                                                                                             | Moss can flip a person's switch for them                         |
| 3.h | Wired, not just defined: through the real chat route, a user with the switch set bypasses the gate, and a grep finds a production caller of the reader        | The reader is defined but never called                           |
| 3.i | Browser test on a dev instance: sign in, open settings, flip the toggle, reload, state persists, send a simple message and see the thinking model answer      | The toggle is not wired to the gate                              |

**Ends with.** Tests 3.a to 3.i pass. Then the admin sets the gate to On for Main chat after the live proof below.

**PR must show.**

- Test output for 3.a to 3.i, scoped, with the exit code. Test 3.f is observed failing once with the policy loosened.
- Crop of the toggle on the settings page (the spec says it is shown to Ben here).
- A grep result showing a production caller of the switch reader and of the route.
- The full local gate result run through the `verify-gate` skill, unpiped, exit code stated.
- App map and manifest changes in the same PR.
- `Release note: Category: Added`, Title "Fast model for simple requests", Description "Simple requests like turning off a light can now be handled instantly. You can turn this off for your account in Settings." This is the first user-visible slice. The PR for slices 1 and 2 uses N/A.

**Live proof for slice 3 (the section 12 proof, in full).** On a dev instance (not `:1533`), with a port from `devports claim`:

1. Sign in through the UI. In Settings choose a decision model (subscription-backed or the cheapest available) and set the gate to On.
2. Send "turn off the kitchen lights" in Main chat. Assert the light state changed through the real integration, the reply posted, no thinking-model turn started, and the activity line names the decision model.
3. Repeat with yolo mode on.
4. Send a message the gate cannot do. Assert it escalated and the thinking model answered.
5. Send a destructive request. Assert an approval card appears.
6. Flip the personal switch off. Repeat step 2. Assert the thinking model answers and no handled line appears. Sign in as the second account and confirm it is still handled.
7. No full-page screenshots, no rewritten network responses. Any stand-in for a third-party service is stated on the PR.

If a step cannot run (for example no Home Assistant on dev), the PR says _code-complete, unverified_ and does not merge (Live-Path Gate).

## 6. App map and manifest updates

All in the same PR as the behaviour they describe.

| Slice | File                                              | Change                                                                                                                                                         |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `packages/shared/src/app-map-core.ts` (~:364-390) | Classifier row: lights and switches can be handled; locks, doors and garage targets are never offered                                                          |
| 1     | `packages/ai/src/manifest.ts:279`                 | `ai.classifier_gate_setting` description gains the same, plus an error and remediation for "device list unavailable"                                           |
| 2     | `packages/shared/src/app-map-core.ts`             | Activity history: handled turns show one line with model, tool and time. Classifier row: private chats and attachments skip it, and what On does in user terms |
| 2     | `packages/chat/src/manifest.ts`                   | Chat feature entry for handled turns, the Main-chat-only scope, and the stop-without-fallback case                                                             |
| 3     | `packages/shared/src/app-map-core.ts`             | New Settings entry for the personal switch: where it is, off-only, affects only the signed-in account, the admin turning the gate On does not override it      |
| 3     | `packages/chat/src/manifest.ts`                   | Declare the switch route; feature entry for the personal switch with its errors and remediations                                                               |
| 3     | `packages/ai/src/manifest.ts:279`                 | Help-line change on the admin row                                                                                                                              |
| 1-3   | `packages/shared/src/app-map-core.ts`             | Remove any statement that a review step is required, if one survives (spec section 11)                                                                         |

A stale or missing entry is a blocker. Reviewers check this table row by row.

## 7. Verification commands

Every command is unpiped. Run the gate only through the `verify-gate` skill, never against the live dev database.

```bash
pnpm --filter @moss/chat test > /mnt/unity-nvme/scratch/front-door-planner/chat-test.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. Scope to the touched test files while iterating.

```bash
pnpm typecheck > /mnt/unity-nvme/scratch/front-door-planner/typecheck.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

```bash
pnpm lint > /mnt/unity-nvme/scratch/front-door-planner/lint.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. Eslint is part of the gate, so builders run it before the PR.

Full gate, before each slice PR is marked ready: invoke the `verify-gate` skill. Expected `EXIT=0`. CI's end-to-end step is not covered locally, so the PR notes that.

Slice 3 browser test (3.i): the Playwright run on the dev instance, expected exit 0, with the output pasted on the PR.

## 8. Kill gate

Spec section 9 sets no trial and no pass mark, so there is no kill gate on the front door itself. The plan keeps two stop conditions with owners.

| Observation                                                                                                                                          | Who decides       | Action                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------- |
| After slice 3 is On: any write, outbound or destructive action handled that should have asked, seen in the monitoring script output or a user report | Ben               | Admin sets the gate to Watch only or Off, fix first |
| Task 1.1 shows the lights cannot be reached without a new module hook                                                                                | Planner, then Ben | Stop slice 1, report, re-plan before building       |

Slice 1 and 2 ship before slice 3 is planned further. The planner re-reads this plan after slice 1 merges, because Q1 and Q2 may change slice 2.

## 9. Slice grouping and PRs

- Slices 1 and 2 touch the same gate files. They share one worktree and may share one PR if the builder stays inside one session. Slice 3 is a separate PR because it is the first user-visible change and carries the live proof.
- One session per slice. A slice that would need two compactions is split again.
- Builders commit at each working step and push the branch.
- No builder merges. The coordinator merges after verified green.
- A migration, if slice 2 needs one, takes the next free number at the moment the PR opens, not at plan time.

## 10. Rulings ledger

| Fact or decision                                                                                       | Source                        |
| ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| No marker on chat replies; activity history is the only trace                                          | Spec section 15               |
| Fixed replies only; model-written replies are out of scope                                             | Spec section 15, 2026-10-31   |
| Admin turns the gate on; each person may turn it off for their account only                            | Spec section 15, 2026-10-31   |
| No trial, no kill gate, no pass mark on the front door                                                 | Spec section 15, 2026-10-31   |
| Lights and switches run without asking when the offered list excludes locks, doors and garage          | Spec section 15, 2026-10-11   |
| No second extraction model; free-text values go to the thinking model for a choice-only decision model | Spec section 15, 2026-10-11   |
| No provider or model name in code or plan                                                              | Spec section 2 and 12 test 8  |
| The per-account switch reuses the owner-only preferences store; no migration                           | This plan, seams check        |
| The lock filter is an allow-list of device types, not a deny-list                                      | This plan, slice 1 decision 3 |
| A switch read failure means no front door for that turn                                                | This plan, slice 3 decision 4 |
| Q1 to Q4 are unproven in the tree and are owned by the builders named above                            | This plan, section 1          |
| The lock exclusion is a per-account setting, default off, set only by its owner                        | Ben via t3, 2026-11-02        |
