# Claude updates must not silently break Meeting summaries

Issue #3689. Follows #3565 (PRs #3608, #3690) and the approved
`2026-10-25-one-path-for-ai-calls.md`. Status: draft for Ben, 2026-11-05.
Mockups: `docs/superpowers/mockups/summary-update-guard/screens.html` (not yet agreed).

## Questions for Ben

1. **Is the lasting fix "finish the one-path plan"?** Meeting summaries already moved to the new
   no-tools route on 2026-10-29 (PR #3837), and that route has no list of allowed versions. What is
   left is slices 3 and 4 of that plan: test every new Claude build against summaries before it goes
   live, then delete the old route and its hash lists. Recommended. Say no if you want a different
   approach (see Options).
2. **Which failure hit the Ring recordings?** I could not prove that the version list caused the
   failures since 2 November (see Findings). Before any build I want to read the real error on
   those recordings. OK to make that step zero, and to change the plan if the cause is different?
3. **How far back should failed summaries re-run?** Proposed: 14 days, which covers the 2 November
   recordings. Longer means more model use when a connection comes back.
4. **Is the existing admin alert enough for a held-back Claude version?** A failed check already
   raises an admin alert, so the proposal is that alert plus the badge on the AI providers screen,
   with nothing new (no email or push).
5. **Is dropping the per-version file hash check at launch acceptable?** The old route refused any
   Claude file whose hash was not listed. The new route relies on the install step's own checks
   instead (see Safety). Slice 4 of the approved plan already says to retire the hash lists; this
   asks you to confirm it knowing that trade.

## Findings (checked 2026-11-05)

- **Prod's live Claude is 2.1.286**, with 2.1.282 kept as the previous copy. Read from the managed
  tools folder, read-only. Prod is not on 2.1.318.
- **The 2.1.318 on the build box is the box's own install**, not the managed copy Moss runs. Other
  hosts that run Moss from source use whichever `claude` is first on the path.
- **The update system worked as designed.** Its last recorded check passed 2.1.286 on 2026-10-01.
  The check tests chat and a structured answer, not the summary route, so it passed a build the old
  summary route then refused. That gap is the real bug.
- **Prod already uses the new route.** Its logs show `no-tools` sessions closing on Claude. On main,
  `meeting-output-runtime.ts` prefers the ACP no-tools adapter when it exists, and the module
  registry always supplies one. The old allowlist
  (`CONSTRAINED_CLAUDE_RELEASES`: 2.1.282, 2.1.286) is only reached when the new adapter is absent.
- **`meeting_output_route_unavailable` is one code for many causes**: no usable default model, model
  lacks summarization or JSON, missing credential, runner not connected, readiness probe says no,
  and (old route only) unlisted Claude build. Users and Moss cannot tell them apart. This is why the
  cause of the Ring failures is unproven.
- **No one is told.** The summary panel shows the generic message and a link to AI providers, which
  shows nothing wrong.

## Why versions were pinned (intent to keep)

From #3565, #3608 and `docs/evidence/3565-meeting-claude/native-compatibility.md`:

- A summary runs on untrusted transcript text, so the model must have no tools, read no project
  files and save no session.
- Each listed build had its archive integrity checked and its native profile controls run (hostile
  hooks do not run, only the output formatter is offered, nothing persisted, cancel kills the
  process), with a removal control that shows the protection matters.
- Unknown or modified builds failed closed.

The fix keeps all three: the same controls run on every new build before it goes live, and a build
that fails stays out.

## Options

| Option                                                                                                                                                                | Stops the break?                               | Cost                                                                                              | Verdict                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| A. Hold updates to a hand-kept list of versions                                                                                                                       | Yes, until someone forgets                     | A person edits the list and runs native proofs for every release; blocks security fixes meanwhile | Repeats the cause. No.       |
| B. Keep a separate pinned Claude only for summaries                                                                                                                   | Yes                                            | A second large install and update story; keeps the private route the approved plan retires        | No.                          |
| C. Only show the mismatch on AI providers, with a fix button                                                                                                          | No. Summaries still break, then an admin fixes | Small                                                                                             | Useful as a part, not a fix. |
| D. Test each new build against the summary route before it goes live (approved plan slice 3), retire the old route (slice 4), add clear messages and automatic re-run | Yes: a bad build never becomes live            | Moderate; mostly extends an existing check and existing screen                                    | **Recommended.**             |

D uses machinery that exists: the update system already stages a candidate, runs a live check,
holds back a failing build and shows "held back" with a Retry button on the AI providers screen.
The only change to that flow is what the check runs.

## Design

### 1. Update check runs the summary profile

- `runLiveCheckSteps` (`packages/ai/src/cli-live-check.ts`) gains a step that opens a session under
  the no-tools profile, proves zero tools are offered, and gets a valid structured answer.
- Failure reasons added to `cliToolReasonText`: `summary_tools_offered` ("would let a model use
  tools during Meeting summaries"), `summary_profile_failed` ("could not write a Meeting summary").
- **Which controls gate every build.** The check proves, per build, each protection the approved
  spec calls independent: no tools offered, no project files or settings read (setting sources off),
  no saved session left behind, and that cancel ends the process. Each has a failure reason and a
  removal control in the build's tests (guard off makes the check fail). The one-time native test
  suite is migration evidence and is not repeated per update.
- Order: tool turn, structured turn, then the summary profile. A build must pass all three to
  promote. Failure leaves the live build in place (existing `held_back` state).
- **First install is different today.** `cli-version-check.ts` promotes a first install before the
  live check, so a failing first build would stay live. The build must run the check before
  promotion for first installs too, or mark an unverified first install unusable for summaries until
  it passes. Test: a failing first install never serves a summary.
- Codex runs the same step. Its real-model run waits on the usage reset noted in the approved spec.

### 2. Retire the old route (slice 4)

Delete `constrained-*` runner files, the release hash table and `constrained-claude-catalog-pin`
tests once the ACP profile passes the same native tests. Until then the old route stays as a
fallback and its hash table is not edited again.

### 3. Say what is wrong

Split `meeting_output_route_unavailable` into causes the user can act on:

| Cause                                          | Code                                       | Who can fix it |
| ---------------------------------------------- | ------------------------------------------ | -------------- |
| No usable default model or credential          | keep `meeting_output_route_unavailable`    | Admin          |
| Runner not connected or provider not signed in | `meeting_output_runner_offline` (new)      | Admin          |
| Installed tool failed the summary check        | `meeting_output_runtime_unsupported` (new) | Admin, or wait |

Mockup copy (see screens): the summary panel names the cause in one sentence, says Moss will retry,
and shows an "Open AI providers" button to admins only. Members are told to ask an admin. The
Today's readiness probe (`acp-no-tools-readiness.ts`) ignores the user and returns only available
or unavailable, so it cannot tell these apart. The build widens its result to a typed reason:
`no_model`, `runner_offline`, `not_signed_in`, or `runtime_unsupported`. Sources: the model selection
for the first, the runner connection for the second, the provider sign-in state for the third, and
the update system's stored check result for the fourth. A rejected candidate does not count:
`runtime_unsupported` applies only when the build that is actually live fails the check, so a
held-back update never makes working summaries look unsupported. The reason travels in the summary
failure record and reaches the panel with the existing error code field.

### 4. Moss can explain it

Same PR updates the app map: the Meetings manifest error catalogue in `packages/meetings/src/features.ts`
(three codes above, with what to do), the "AI providers - CLI software" entry in
`packages/shared/src/app-map-core.ts` (held back now includes "would break Meeting summaries"), and
the Meetings feature text for the automatic re-run. A stale entry blocks the PR.

### 5. Failed summaries re-run

- A worker sweep (hourly) looks for meetings whose latest automatic summary failed with one of the
  three codes within the window (14 days, Question 3) and has no later success.
- For each, it checks the owner's readiness probe. If ready, it enqueues the existing automatic
  summary job. Payload stays three UUIDs (meeting id, actor id, request id), as the worker requires
  today (`stop-summary-jobs.ts`).
- **A plain re-enqueue does nothing.** Admission requires the stored request id to match, and
  replaying the original request returns its stored failure without calling the model
  (`stop-summary-repository.ts`, `output-service.ts`). Recovery therefore needs one atomic step that
  allocates a fresh request id, resets the automatic-summary record and input to pending, keeps the
  revision protections, and counts the attempt. Test through the real worker that a fresh model call
  happens.
- Runs under each owner's own context. No admin bypass, no cross-user read.
- At most 3 recovery attempts per meeting. After the third the panel says Moss has stopped retrying
  and points to Rewrite summary. Capped per sweep so a returning connection does not burst the
  model. Manual Rewrite is unchanged and always available.
- Success shows the "written automatically" note in the mockup.
- Build plan must confirm which existing job/sweep infrastructure to reuse before adding any.

## Screens that change

Two, both in the mockup file, and both reuse existing components (`Badge`, `Button`, card).

1. **Settings / Admin / AI providers, Anthropic card.** Only the held-back reason text and a one-line
   explanation change. Normal and "all fine" states shown.
2. **Meeting summary panel.** Cause-specific failure text, admin-only button, and the recovered note.

Empty, loading and broken states are listed at the bottom of the mockup. Nothing else on either
screen moves. No new screen. Ben must agree the mockups before build.

## Safety

- The new route's guards are the three Claude session options (tools off, no setting sources, no
  saved session) plus the post-launch proof of zero tools, per the approved spec.
- Dropping the hash table removes the launch-time check that the Claude file matches reviewed bytes.
  The install step still checks the package lockfile integrity, pins a hash over the promoted tree
  and re-hashes after promote. It does not re-hash at launch. Build plan must read the launch code
  and state what really guards the file between install and use before the PR says "integrity
  verified" (Claims About Security Properties rule). Question 5 asks Ben to accept this.
- No secrets or content added to logs, job payloads or the new codes.

## Tests

Each guard seen failing with the guard removed.

- Live check: a fake build that offers a tool fails with `summary_tools_offered` and is held back; a
  build that cannot answer fails `summary_profile_failed`; a good build promotes.
- `deriveCliToolsDto` shows `held_back` with the new reason text.
- Runtime: each cause maps to its own code; the old catch-all no longer covers the other two.
- Summary panel: each code renders its message; button only for admins; members see the ask-an-admin line.
- Sweep: recovers a failed meeting once ready; skips a meeting with a later success; honours the
  window and the three-attempt cap; never reads another owner's meeting (RLS test); payload has ids only.
- App map tests and `pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm verify:static`.

## Live-path proof (required before Done)

On a disposable instance through the real UI, no faked responses:

1. Read and record the real error on the failing Ring recordings (step zero).
2. Stage a Claude build that fails the summary check; the AI providers card shows it held back with
   the reason, and chat and a fresh summary still work on the live build.
3. Break the runner connection; a new recording's summary shows the offline message, not the old one.
4. Restore it; the sweep re-runs the failed summary and the panel shows the recovered note.
5. Re-run the 2 November recordings and confirm summaries appear.

## Out of scope

Gemini and OpenCode summaries, API-key model route, chat behaviour, transcription, provider and
model settings, and prod deploys.
