# Typography and copy audit verification

Date: 15 October 2026. Status: **live-path acceptance passed; final CI required before merge**.

The implementation was grounded on current main
`3b3915e9126092610460852c44c6e0a149b0ad3f`. The source audit was pinned to
`5b498c6557a821e7c244545b8b444bfb34d91a39`; its complete 22-page text was read through
Library and saved in the executor. Binary DOCX/PDF transfers returned HTTP 403. Read-only
checks found only documentation PRs #3511 and #3440 open, without runtime-file overlap.

Five implementation owners and one independent reviewer used GPT-6.1 Sol at xhigh. Shared
primitives had one writer. Review feedback corrected cached-account error reporting, chart
tooltip clipping and selected-day visibility, and dark-mode keyboard focus.

## Scope

Repairs cover F01–F09 and F11–F16: readable palette and chart text, explicit shared title and
eyebrow roles, all Markdown heading levels, one Trends loading announcement, semantic Goals
and settings headings, Sports controls and sibling titles, scheduled/Discuss hierarchy, and
truthful setup, connection, Food and Finance states. Selected authored copy is clearer while
retaining approval, draft/send, suppress/reject and uncertain-save distinctions. App-map
declarations follow the changed states and labels.

Today's editorial geometry, onboarding composition and native typography/artwork are
preserved. Optional F10 chat/Meetings reading-role consolidation and native privacy-copy
proposals remain deferred pending real-content and platform review.

## Automated checks

All commands below returned exit 0. Installed tool entry points were called directly because
the pnpm launcher attempted a package-manager install outside the writable workspace.

| Check                                                                    | Result                                       |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| Focused regression run                                                   | 477 tests across 33 suites passed            |
| Full ESLint and Prettier checks                                          | Passed                                       |
| Root, tests and web TypeScript                                           | Passed                                       |
| Finance, Food and Job Search TypeScript                                  | Passed                                       |
| Production web build                                                     | Passed; existing large-chunk warnings remain |
| App-map build                                                            | Passed                                       |
| File size, design tokens, UI classes, migrated sections and UI catalogue | Passed                                       |
| Whitespace check                                                         | Passed                                       |

The focused run includes all five new `typography-*-audit.test.tsx` suites and the existing
affected state, permission, Markdown, settings, Wellness, Finance, Food, Discuss, Workshop,
meeting and Today tests. Existing assertions were updated for intentional wording changes;
no tests were disabled or excluded from compilation.

## Independent Chromium evidence

Chromium 154.0.8037.57 passed **38 scenarios and 247 assertions**, with no failures or API
requests. Actual components and authored CSS were bundled with workspace source aliases,
real module-route metadata and self-hosted fonts. Query-cache inputs were synthetic. This
is bounded component evidence, not live end-to-end acceptance.

- Widths: 320, 390, 560, 768 and 1280 pixels; Forest light/dark and Sage light.
- Smallest painted SVG label: 11px, using the SVG transform rather than local font size alone.
- Markdown h5/h6: 13px/12px, including a smaller parent context.
- Actual title font: custom Archivo SemiBold; explicit title weights/leading and semantic
  Group/Goals headings were checked.
- Palette keyboard navigation, root/list empty states, chart keyboard scrolling, selector and
  data table, initial/error/stale Trends states, and light/dark focus rings passed.
- First/middle/last-day tooltips and a 20-medication tooltip stayed contained and scrollable.
- Representative sampled contrast was at least 5.15:1; this is not an exhaustive contrast audit.

The reviewed tracked patch SHA-256 before commits was
`5bcfbee60cc80192d66ad1ff13c755707ce83b0b1d42d22b4b0c31356e3b2e18`.

## Live-path acceptance

The tracked `tests/uat/specs/3526-typography-copy.uat.spec.ts` passed against a locally built
production image and disposable Postgres instance. The complete command returned exit 0;
Playwright reported **1 passed (54.1s)**. The harness removed its containers and data volumes.

```sh
JARVIS_UAT_BUILD=0 JARVIS_IMAGE_TAG=uat-pr3526-final2 \
JARVIS_UAT_CLAIMED_WEB_PORT=5182 MOSS_UAT_CAPTURE_OFF=1 \
JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE=/tmp/pr3526-no-chat-auth \
pnpm test:uat 3526-typography-copy.uat.spec.ts
```

Port 5182 was claimed with `devports` for this run. The deliberately nonexistent auth-file
override prevents the harness from borrowing host chat credentials. Image SHA-256:
`53ef1f2dca9bdcb67c83a9bacadd861a2bae1079087bc606df7a85d46fe552ed`.

Executable assertions proved these assembled paths without network interception or replay:

- Real owner signup, setup recap and completion, with the completed state surviving reload.
- Account menu → Settings → Connections, semantic Accounts heading, neutral connection copy,
  and the real Google OAuth configuration instructions.
- Main navigation → Wellness, a check-in saved through its public API and read after reload,
  selected-day medication/mood status, and the daily-values table at 1280, 390 and 320px.
  Minimum painted chart text measured 13.87px, 13px and 13px respectively.
- Finance, Food and Job Search built locally, copied into the disposable module volume,
  discovered on restart, enabled through Admin / Setup → Instance modules, and restarted.
- Main navigation → Finance → Finance settings, a $125 budget-move limit saved and verified
  after reload; main navigation → Food, its actual empty-day heading and meal instructions.
- No browser page errors.

Live proof exposed a pointer interaction bug: dismissing the selected chart day on a daily-values
pointer-down shifted the disclosure before its click. The fix includes the chart's data controls
in its dismissal boundary. A focused regression failed before the fix and passed afterwards,
while still proving an outside pointer-down dismisses the selection.

Merge preparation also bumped Finance/Food/Job Search to 0.6.10/0.3.12/0.2.20 so changed
artifacts satisfy immutable registry versions, updated stale unit/browser/UAT copy assertions,
and removed a remaining unsupported ServicePicker privacy assurance. Local registry checks
accepted all three artifacts. Full `pnpm verify:static` passed before the final chart fix;
focused chart/copy regression suites (39 tests), scoped lint and tests/web TypeScript passed
after it. All 62 affected browser scenarios passed across the final run and focused rerun.

## Remaining platform coverage

No external Google account was authenticated: the proof covers the real setup instructions,
not an OAuth token exchange. The 200% fixture used CSS magnification rather than native
browser zoom. Screen-reader and macOS/native rendering checks remain open. These platform
limits are separate from the passed live application paths above. CI must pass on the final
PR head before merge; no production deployment was performed as part of this proof.
