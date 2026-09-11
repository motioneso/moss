# Slice 8: Assembled verification and release readiness

**Goal:** Prove the approved experience through the real UI and leave truthful release evidence.
**Dependencies:** slices 1–7 complete on the candidate revision; readiness/state decisions resolved.

Read the [shared plan](2026-09-10-today-briefings.md) and
[behavior/acceptance matrix](2026-09-10-today-briefings-behavior-and-verification.md).

## Files and harness

Reuse `tests/e2e/briefing-action-rows.spec.ts`, `tests/e2e/mock-briefings-api.ts`,
`tests/uat/specs/1452-briefing-live-content.uat.spec.ts`, the current UAT runner/provisioner and
Playwright configuration. Proposed new `tests/uat/specs/today-briefings.uat.spec.ts` and focused mock
`tests/e2e/today-briefings.spec.ts`. Keep existing module/provider tests as the source for fixtures;
do not create another test runner or store personal provider credentials in test artifacts.

## Task 1: Complete regression and source-state proof

- [ ] Trace every row in the behavior matrix to an existing or new assertion. Cover full read,
      source/material evidence, proposed/automatic/off modes, partial/bulk actions, explicit unscheduling,
      current preference changes, missed evening preparation and source/model recovery.
- [ ] Assert persistent shared state across Today, task details, report, review, evening intent and
      next-morning generation. Include an actual reload and a process/worker restart where relevant.
- [ ] Exercise isolated two-actor ownership and shared-source boundaries. A shared definition or
      task cannot disclose another actor's run/plan or authorize a provider write.
- [ ] Cover stale revision and simultaneous apply, worker/UI duplicates, provider success/local
      failure, late calendar conflict and retry. Assert real per-item effects and task/deadline retention.
- [ ] Assert automatic generation's transaction sequence through the actual worker path:
      composition emits intents with no calendar-provider writes; run/reservation commits before apply;
      provider I/O uses no `generateRun` transaction handle; post-commit crash and duplicate-run retry
      recover durable pending operations without duplicate events or false committed prose.
- [ ] Verify morning default-on News/Sports and separate off states through the actual Settings
      route, including explicit existing choices, disabled modules and excluded publisher/topic content.
- [ ] Validate previous-night/live/tonight/quiet sports boundaries, score truth, photos and image
      failures, weather location/units/high-low/five-day retention, and existing rich Wellness flows.
- [ ] Check 320/375/768/1440 widths, 200% zoom, long data, keyboard-only dialogs, focus restoration,
      invalid/loading controls and non-color status. Review reference images separately from live proof.

## Task 2: Run the right checks with the right target

Safe examples after code changes (confirm filenames on the candidate before running):

```bash
pnpm exec vitest run tests/unit/today-briefing-prose.test.tsx tests/unit/today-evening-mode.test.tsx tests/unit/today-briefing-action-rows.test.tsx
pnpm exec vitest run tests/unit/briefings-default-tools.test.ts tests/unit/briefings-compose.test.ts tests/unit/briefings-schedule.test.ts
pnpm exec vitest run tests/unit/calendar-follow-through-port.test.ts tests/unit/calendar-signals-modes.test.ts tests/unit/calendar-confirmation-policy.test.ts tests/unit/source-context-calendar.test.ts
pnpm exec vitest run tests/unit/news-today-widget.test.tsx tests/unit/news-service.test.ts tests/unit/sports-service.test.ts tests/unit/open-meteo.test.ts tests/unit/weather-service.test.ts
pnpm exec playwright test tests/e2e/briefing-action-rows.spec.ts tests/e2e/today-briefings.spec.ts --project=chromium
```

New plan/UI test files named in the slices must be added to these focused runs. Mock browser calls
must be fully intercepted; an unhandled request cannot fall through to a real account mutation.

- [ ] Per session run `pnpm exec eslint <actual-touched-source-and-test-files> --max-warnings=0`,
      scoped `pnpm exec prettier --check <actual-touched-files>`, and root/test-aware `pnpm typecheck`.
      Placeholders are replaced by the real path list; do not run the angle-bracket example literally.
- [ ] Run `pnpm verify:static` on the finished candidate, including authored token/UI class checks,
      no-ambient-date/package-dependency checks, and app-map build. Record unrelated base failures
      separately; don't claim the candidate is green because a scoped subset passed.
- [ ] Run DB integration through the mandated verify-gate/protected workflow against an isolated,
      authorized target. The scoped runner is `pnpm exec tsx scripts/test-integration.ts <actual-files>`;
      merely using that command is not proof that the target is isolated.
- [ ] Run `pnpm verify:foundation` only through that protected procedure. Do not pipe away the exit
      code or use the default live dev database. Missing safety tooling means record the missing gate.

## Task 3: Real UI/live dev proof

- [ ] Use the current protected UAT provisioning workflow and disposable authorized actor. Follow
      actual signup/login, module/Settings setup, and Today entry. Recheck #2296 if the loader hangs;
      stop and diagnose that known entry failure instead of repeating long waits.
- [ ] Record installed API/web/worker revision and selected model/source configuration without
      secrets. Verify Bone/Archivo via actual active theme, DOM attributes, computed variables,
      `document.fonts.check` and font resource responses; source history alone is not runtime proof.
- [ ] Generate real morning/evening runs via the actual UI/settings path. Exercise real declared
      source setup, including News/Sports configuration ordering (#2313).
- [ ] On the authorized test calendar, accept some/all blocks, move/remove only plan-owned blocks,
      reload, and verify the resulting calendar/task/plan state. Do not mutate Ben's personal calendar
      or fabricate provider proof from intercepted responses.
- [ ] Save actual evening intent and generate the target-day morning in the harness's controlled
      clock/environment. Confirm capacity, correction and priority survive, with an overnight source
      change requiring only the appropriate adjustment.
- [ ] Record the UAT command, target/revision, exit code, assertion summary and bounded DOM/network
      evidence. Keep screenshots for design review only. Never include cookies, auth tokens or raw
      private source content in artifacts.

## Task 4: Release-ready handoff

- [ ] Review final diff for standards/spec compliance, module boundaries, reusable seams, source
      trust, missing remediations, and absence of unrelated shared-checkout edits.
- [ ] Check the core Today and owning Briefings/Calendar/News/Sports/Weather/Wellness app-map entries
      against actually shipped behavior, including off, missing-account, stale-plan and partial-failure
      states. Remove outdated coming-soon claims only where functionality is complete.
- [ ] When publishing is authorized, use the repository's shared-checkout procedure, explicit file
      staging, a linked task and normal review/CI. Fill the release note: Category **Changed**; proposed
      title **A prepared day, from evening to morning**; description grounded in the final shipped scope.
- [ ] Attach the real-path evidence to the implementation PR using the authorized publishing flow.
      CI-green and prototype screenshots alone never mark the task Done.
- [ ] Report **release-ready** only with all required gates and live evidence. Otherwise state the
      exact missing proof (**code-complete, unverified** where applicable). Merge/deployment remains
      subject to the normal authority; writing this plan does not authorize either.

Stop when implementation, required checks, live-path evidence and tracking describe the same exact
candidate. Do not report completion of only the styling as completion of the approved feature.
