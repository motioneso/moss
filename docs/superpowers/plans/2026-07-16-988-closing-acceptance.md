# Plan — #988 Closing UX Acceptance

- **Spec:** `docs/superpowers/specs/2026-07-16-988-closing-acceptance.md`
- **Status:** Proposed; D1/D2 resolved; stop after planning PR until Ben approves the overall spec
- **Grounded on:** `origin/main` `a0887ead` and live #988/#983 on 2026-07-16

## Scope and gates

This plan separates implementation from proof. Tasks 1–2 are conditional on Ben approving D1/D2.
Tasks 3–6 are acceptance work. Do not merge, close/move issues, or start any task below from this
planning branch.

Before execution, record:

```bash
git rev-parse HEAD
gh issue view 988 --repo motioneso/Jarv1s --json state,body,url
gh issue view 983 --repo motioneso/Jarv1s --json state,body,url
pnpm audit:preflight
```

If preflight is red or a previously closed #983 child has reopened, stop and reground the plan.

## Approval gate — Ben, no code

Record each decision in writing:

1. **Today — approved by Ben 2026-07-16:** remove the proactive-card pill that literally prints
   `critical`, `high`, `normal`, or `low`; keep task-row short dates rendered in the user's persisted
   timezone; retain order, priority stripe, drift state, source, and detail.
2. **Appearance — approved by Ben 2026-07-16:** independent light/dark mode for the five built-in
   accent themes, legacy Dark → Forest+dark normalization, and fixed-mode custom themes for this
   slice. Theme/accent selection and mode selection remain independent.

If either answer changes the proposed behavior, update the spec and this plan before implementation.

## Task 1 — Today duplicate-pill cleanup (D1 approved; overall implementation gate remains)

Files:

- Modify `apps/web/src/today/proactive-cards.tsx`
- Create `tests/unit/today-closing-polish.test.tsx`

Steps:

1. Add one focused failing render assertion: proactive cards do not expose the raw priority-band
   text; title, source, summary, and dismiss behavior remain.
2. Add a timezone-boundary assertion that the existing `shortDate(..., locale)` path renders the
   task-row date in the persisted user timezone, not the browser or UTC timezone.
3. Delete only the proactive-card pill. Do not change ranking, task DTOs, task dates/details, the
   shared zoned formatter, or other pages.
4. Run:

```bash
pnpm vitest run tests/unit/today-closing-polish.test.tsx
pnpm check:design-tokens
pnpm typecheck
```

5. Capture desktop+narrow Today proof with ordinary, high-priority, due-soon, and overdue fixtures.
   The short date must match the persisted user timezone; order and drift remain understandable
   without the removed pill.

## Task 2 — Independent built-in color mode (D2 approved; overall implementation gate remains)

Expected files:

- Modify `packages/shared/src/themes-api.ts`
- Modify `packages/settings/src/themes-routes.ts`
- Modify `apps/web/src/api/theme-client.ts`
- Modify `apps/web/src/shell/app-shell.tsx`
- Modify `apps/web/src/shell/theme-storage.ts`
- Modify `apps/web/src/settings/settings-appearance-pane.tsx`
- Modify `apps/web/src/styles/tokens.css`
- Modify focused theme/appearance/contrast/capture tests already covering those files

Steps:

1. Add failing contract tests for a returned/saved `light | dark` mode, independent active theme,
   legacy `activeId=dark` normalization, and fixed-mode custom-theme behavior.
2. Store mode in the existing owner-scoped preferences repository. Extend the existing themes API;
   add no table, migration, state library, or parallel settings service.
3. Apply separate `data-theme` (accent) and `data-color-mode` attributes in the shell. Preserve the
   stored `light` id as Forest; remove Dark as a selectable accent only after compatibility tests
   pass.
4. Split dark base surfaces from accent overrides in `tokens.css`. Add the minimum dark accent ramps
   for Forest/Sage/Canyon/Teal/Dusk and keep semantic warning/error colors locked.
5. Add the existing segmented/settings treatment to Appearance. Theme selection must never change
   mode and mode selection must never change theme. Explain/disable mode for a selected custom
   fixed-palette theme.
6. Update local boot fallback and capture fixtures without wiping existing user preferences.
7. Run:

```bash
pnpm vitest run tests/unit/settings-themes-routes.test.ts \
  tests/unit/settings-appearance-pane.test.tsx tests/unit/theme-runtime.test.ts \
  tests/unit/web-shell-theme.test.ts tests/unit/shared-contract-schemas.test.ts \
  tests/unit/design-tokens-contrast.test.ts
pnpm check:design-tokens
pnpm typecheck
```

8. Live-check all 10 built-in combinations (five accents × two modes) at desktop and narrow.
   Verify text, controls, focus, disabled, warning, error, and selected states. Custom-theme behavior
   must match D2 exactly.

## Task 3 — Prove already-landed behavior; no expected code

Run focused existing evidence first:

```bash
pnpm vitest run tests/unit/news-rss-source.test.ts tests/unit/news-image-route.test.ts \
  tests/unit/news-service.test.ts tests/unit/news-page.test.tsx \
  tests/unit/sports-newsband.test.tsx tests/unit/sports-page.test.tsx
pnpm playwright test tests/e2e/settings-shell.spec.ts tests/e2e/news-settings.spec.ts \
  tests/e2e/sports-settings.spec.ts tests/e2e/skills-settings-chat.spec.ts --workers=1
```

Then verify on the live UAT page:

- News uses the best source rendition available; its browser URL is the same-origin article image
  route; an unavailable image degrades to the existing text-only layout.
- Sports does not stretch logo-sized art as a feature photo and degrades cleanly when art is absent.
- Shared wrapping, spacing, typography, contrast, hierarchy, focus, popover dismissal, and Settings
  reachability remain correct after all closed lanes are combined.

Do not add another image proxy, resize service, or screenshot harness. A failure becomes a scoped
defect with current evidence.

## Task 4 — Run the fresh acceptance sessions

Use `tests/uat/provisioner.ts` from a local Webwright workspace; generated scripts, logs, and images
stay under `final_runs/run_<id>/` and are not committed. Each critical point gets an action-log line
and a sanitized explicit text result.

Run A — first-time onboarding (`solo-admin`):

- Desktop and narrow owner onboarding from Welcome through Finish.
- Back/continue/optional-step/skip behavior, truthful CLI/provider/connector state, and both finish
  destinations where safe.

Run B — lived-in closing walkthrough (`admin+data`, desktop then narrow):

- Today through every primary module and every personal/admin Settings group.
- Your data/export; cancel deletion on the main owner.
- Connected email/calendar grant state and recovery; model selection; News feedback; skill upload,
  validation, invocation, disable/delete; Activity success/empty/loading/error truth.
- Private/history trust, approvals/popovers, Notes/People, Sports, Memory, host/account, and all
  `Coming soon · #issue` commitments.

Run C — disposable destructive proof (`multi-user` or a fresh disposable UAT owner):

- Export before delete, validation/confirmation, successful deletion, loss of login, and survival of
  the other owner. Never perform this against the deployed personal account.

Run D — deeper News:

- Add/edit/remove topic, Enter behavior, validation failure retention, feedback, empty state,
  revalidation/refresh, article navigation, best-image and no-image cases, keyboard use, and narrow
  overflow.

Run E — microphone:

- On an authorized secure context with transcription configured: permission, start, stop, and
  transcript insertion; no raw audio/error detail leaves the browser.
- On plain-HTTP LAN: record the actual blocked behavior and link the outcome to open #900 and #901.
  Do not mark those issues fixed and do not absorb their implementation into #988.

## Task 5 — Checkbox-to-proof ledger

Complete this ledger in the #983 evidence comment. A row cannot be marked complete without its
proof/deferral link.

| #988 checkbox                                                              | Required disposition                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Today redundant ranking/due labels                                         | Task 1 commit + desktop/narrow proof, or Ben-directed deferral            |
| News/Sports imagery                                                        | Task 3 focused tests + live best-art/no-art proof                         |
| Appearance independence                                                    | Task 2 commit + 5×2 contrast/interaction matrix, or Ben-directed deferral |
| Shared visual fixes                                                        | Combined Run B desktop/narrow proof                                       |
| Your data, deletion, grants, models, News feedback, skill upload, Activity | Runs B/C/D result per item                                                |
| Microphone vs #900/#901                                                    | Run E evidence + explicit issue links                                     |
| First-time onboarding                                                      | Run A desktop+narrow evidence                                             |
| Deeper News                                                                | Run D evidence                                                            |
| Complete desktop+narrow walkthrough                                        | Run B action log and narrated summary                                     |
| Readable independent modes                                                 | Task 2 matrix                                                             |
| Appropriate safe images                                                    | Task 3 source/proxy/live proof                                            |
| No unresolved P0/P1                                                        | Fresh live issue query + zero unowned blockers                            |
| Every #983 finding disposed                                                | 37-row parent matrix: proof, deferral, or disproved                       |
| Narrated pass and release note                                             | Final #983 comment/attachment                                             |

For the parent matrix, cite the merged/UAT evidence for closed #984–#995/#1002 where it still proves
the current behavior, then add fresh Run B evidence for combined regressions. #1003 is an explicit
future deferral, not a hidden pass.

## Task 6 — Final verification and evidence handoff

After any approved implementation:

```bash
pnpm verify:foundation
pnpm audit:release-hardening
git diff --check
git status --short
```

All commands must exit 0. Sanitize the Webwright log/screens before attachment. Post to #983:

1. tested SHA/environment/viewports;
2. the completed #988 ledger and 37-finding disposition matrix;
3. P0/P1 query result and deliberate deferrals with owners/triggers;
4. narrated desktop+narrow summary;
5. release note: “Jarv1s’ dogfood UX pass now keeps settings and core workflows readable,
   truthful, and recoverable across desktop and narrow screens, with remaining platform-dependent
   microphone work tracked explicitly.”

Then report evidence to the UX Coordinator. The Coordinator/Ben owns merge, issue closure, parent
checkbox updates, and board state.
