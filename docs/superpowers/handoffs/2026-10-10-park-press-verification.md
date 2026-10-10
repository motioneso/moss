# Park Press migration verification

## Status and scope

This is a staged, draft-only repair of the approved retained-screen migration plan.
It is not release acceptance. The foundation batch is independently reviewable;
consumer changes and their app-map declarations follow in separate dependent batches.
No merge, deployment, live database operation, or native branding change is included.

The approved specification and implementation plan are in
[`../specs/2026-10-10-park-press-migration.md`](../specs/2026-10-10-park-press-migration.md)
and [`../plans/2026-10-10-park-press-migration.md`](../plans/2026-10-10-park-press-migration.md).
Exact ownership is registered in the companion ownership CSV. Audit finding IDs
below refer to the delivered 2026-10-10 audit, rather than newly created issues.

## Foundation batch

The foundation repairs shared semantic text and focus roles, minimum shared type,
modal lifecycle, settings adapters, Menu/tooltip keyboard contracts, scoped token
validation and canonical component reuse. Three existing Settings eyebrow sites
are lifted into this batch solely so the expanded component guard is independently
valid; the remaining Settings behavior changes stay in the core batch.

Independent review found and repaired persistent nested-modal return focus,
focus entry under a previously inert sibling, complex dialog-title width,
repo-wide leakage of local CSS variables, comment-only token declarations and
NavIndex family matching. Browser negative cases were reproduced before repair.
The two boot/app body minimum widths now respect the scrollbar-reduced viewport.

| Finding | Bounded result and remaining proof |
| --- | --- |
| F-01 | Shared muted text uses semantic foreground roles. Consumer surfaces require their own checks. |
| F-02 | Shared text-floor repairs and selector assertions implemented; whole-app rendered floor is a consumer gate. |
| F-03 | Shared modal lifecycle handles focus, Escape, isolation, nesting and separate UI bundles; nonmodal remains explicit. |
| F-04 | Settings adapters route shared primitives with explicit control/hint/error associations. Consumers must supply matching IDs. |
| F-05 | Legacy global control/type rules are scoped to preserve shared controls. |
| F-06 | Current extraction and typography/material guidance reconciled. Historical design choices are not silently replaced. |
| F-07 | App/shared/module token scope and explicit cross-file inputs enforced; negative scope/comment tests added. Not a universal module-local class-existence checker. |
| F-08 | Named-theme selector/ground and focus pairs tested. The core batch below supplies actual custom-theme readouts; arbitrary palettes are not automatically corrected or guaranteed compliant. |
| F-09 | Flat shared material and reduced-motion contracts repaired; rendered consumer motion remains a separate check. |
| F-10 | Editorial SectionHead/RowIndex contracts documented and preserved. |
| F-11 | Menu roving focus, trigger association and tooltip descriptions/Escape covered. Native browser Tab/Shift+Tab within a modal were exercised. |

### Local checks

Dependencies were installed using declared pnpm 10.6.2, frozen lockfile, offline
store and ignored install scripts. No package versions were changed in this batch.
Direct installed Node CLIs are equivalent to the repository scripts here; the
`tsx` CLI's IPC server is unavailable in this execution environment, so guards use
`node --import tsx`.

- Root, test, web, Finance, Job Search and Food TypeScript checks passed serially
  with a 4096 MB heap on the isolated foundation candidate.
- Scoped ESLint with `--max-warnings=0`, changed-file Prettier and `git diff --check`
  passed.
- File-size, design-token, shared-class, migrated-component, catalogue,
  ambient-date, development-password, package-dependency and migration-number
  guards passed. The password check does not establish credential rotation or
  erase historical exposure.
- App-map generation passed without introducing routes or capabilities.
- Foundation contract/theme/catalogue/unit regressions passed, including the
  independent negative repairs. The final PR body records the exact test count
  and code head used for its final verification.

### Follow-up from first draft CI and browser review

The first published head, `8bddc23c88ea49d700acb2c97d036e2541f990a2`, did not
pass CI. Its unit run found three stale Meetings input-boundary assertions after
the deliberate shared selector change. Its web run found two ambiguous label
queries because a fallback named Field group duplicated an independently named
input. These are recorded failures, not flakes or a claimed initial green run.

The correction lifts the existing matching Meetings regression into this
foundation batch without removing control-type or boundary combinations. Field
wrappers are neutral by default, retain explicit single-control association, and
provide an explicit named-group opt-in for genuine multiple controls. Existing
independently named inputs no longer get a second matching accessible element.

Source-faithful consumer review also exposed a StrictMode effect-replay race:
queued cleanup could return focus after a replacement setup had focused the
surface. Per-hook setup generations now cancel only stale cleanup restoration;
true unmount, nesting and nonmodal outside-focus behavior remain covered. Both
new replay cases and both CI label cases were observed failing before repair.
Independent source review and focused regressions passed on the correction.
A fresh CI result must be observed for the updated remote head.

### Source-faithful browser observations

The supported cloud Chromium browser rendered the actual shared source against
synthetic, isolated fixtures. Nested persistent dialogs and a sibling opened
inside a formerly inert wrapper now receive and return focus correctly. The
complex Task title occupies its full 618 px heading slot. Menu Tab and Shift+Tab
leave the menu without dismissing the containing modal.

At 320 px viewport width with a vertical scrollbar, the expanded Memory fixture's
page width changed from 320 px against 305 px usable width to 305/305. At 390 px
and 1440 px it measured 375/375 and 1425/1425; primary controls remained visible.
These observations establish fixture layout and interaction only, not live data,
server authorization, provider behavior or assistive-technology acceptance.

## Core retained-screen batch

This dependent batch implements the C1-C5 repairs and their existing-route recovery
metadata. It also supplies the opt-in semantic token scope required to measure a
custom palette in isolation from the active outer theme. Palette values and the
existing Save policy are unchanged; a failing pair is a nonblocking warning, not
an automatic palette modification or a compliance guarantee.

| Finding | Result |
| --- | --- |
| CORE-01 | Memory has authored, responsive rows and named controls. Active #3084 FactActions import/export/delete call remains untouched. |
| CORE-03 | Memory, People, members, oversight and audit distinguish failed reads from empty results and expose recovery while retaining confirmed rows. |
| CORE-04 | Auth and onboarding use the approved shared control/type contracts. |
| CORE-05 | Onboarding step labels point to actual heading IDs. |
| CORE-06 | Onboarding/Today dialogs use shared lifecycle; the source tray deliberately remains nonmodal with focus entry, Escape, return and associated trigger. |
| CORE-07 | Account actions use shared Menu; the phone navigation uses modal lifecycle, a named close control and actual expanded/controls state. Closed phone navigation is hidden from focus; desktop resize releases modal state. |
| CORE-08 | Plan and workflow approval presentation uses shared controls while preserving pending and repeated-click guards. |
| CORE-09 | Today semantic band text and wrapped action spacing repaired without changing the approved composition. |
| CORE-10 | Missing local form/action layout hooks implemented. |
| CORE-11 | Activity uses canonical Settings heading anatomy. |
| CORE-12 | Theme deletion and encryption-key actions use authored confirmations with existing consequence/cancel semantics. |
| CORE-13 | Offline fallback uses the retained shared visual identity. |
| CORE-14 | Merged Finance module-owned Settings link is migrated. Conversations/Alerts from active #3154 are still held, not recreated or claimed complete. |
| CORE-15 | Owned core underfloor text repaired; no claim of exhaustive whole-app rendered typography validation. |
| CORE-16 | Priority settings use shared controls and distinguish read/write recovery. |
| F-08 C4 | Nine readability readouts measure actual computed semantic foreground/ground pairs. Built-in duplicates and draft previews explicitly isolate their own palette/mode; warnings describe limited coverage. |

Focused tests cover failed-read retries, retained drafts, destructive cancellation,
mobile open/close/scrim/Escape/reopen, account navigation focus, responsive modal
release and separate nonmodal source trays. Independent review includes stale
closure/measurement and multiple-message source-tray probes. Source-faithful
browser measurements verified all nine readability results against rendered
colors and independently recalculated contrast, including a failing dark-palette
pair and a changed custom light palette. No theme Save was issued in browser proof. SourceTray was
rechecked under the real app StrictMode after the shared replay fix: Enter focuses
Close source, Tab remains free, Escape and Close restore the opener without closing
parent Chat, and a visible outside pointer click preserves the chosen textarea focus.
Location and Skills explicitly name genuine mixed control groups; OpenCode directly
associates its model label and hint with its select. The active Location branch patch
remains apply-compatible.

This batch adds no routes or authority. Core declarations describe the repaired
recovery controls in the same batch. The active Memory and host chat patches were
apply-checked for compatibility; no other branch was edited or imported wholesale.
Final command counts and remaining browser cases are recorded in its draft body.

### Core CI assertion follow-through

The first core draft head exposed browser acceptance tests still waiting on the
removed account-menu styling class and button roles for items now correctly
represented as menuitems. The account readiness waits now target the named Account
menu button, including unread-count suffixes. Contextually verified Settings,
Notifications and Log out assertions use menuitem roles. Authentication fixtures,
waits, timeouts and navigation outcomes are preserved, with closed/open and
unread-count runtime coverage added.

Directly affected Auth name assertions follow the actual canonical eyebrow inside
the auth panel, retaining exact saved/default-name expectations. Encryption-key
replacement acceptance now exercises the authored confirmation: safe initial
Cancel focus, cancellation without a request, then one explicit confirmation and
the original ready outcome. Today medication tests retain Escape, Done, backdrop
and opener-return checks using the intended initial focus and shared backdrop.
These are repaired assertion contracts, not successful first-run CI claims.

The active scheduled work's three affected sign-in specs and the attachment
fixture patch remain apply-compatible. Its assistant-name patch already conflicts
with current main's newer model fixture before this migration; the locator-only
changes are disjoint and do not import or revert that pending branch.

## Explicit outstanding gates

- Later planning, lifestyle and Meetings/Finance batches must receive their own
  source/test/browser review and same-PR metadata. The final bounded module-local
  class guard remains a separate dependent followup.
- Active PR-owned Conversations/Alerts changes are not imported or rewritten by
  this foundation batch. Relevant disjoint patch compatibility is recorded in the
  freshness handoff; overlapping future changes still need reconciliation.
- Meals/Food replacement, Job Search replacement, native branding precedence and
  Finance Reports retirement remain decision-gated or preserved as specified.
- No Docker-backed isolated foundation/integration gate ran. No live database or
  service was used. The real-data live-path gate remains outstanding.
- macOS/Xcode, VoiceOver and native runtime proof require a supported Mac; web
  screenshots do not replace them. Actual paginated export printing remains a
  separate verification gate.
- CI is not claimed until the draft exists and its checks are observed. Nothing
  here authorizes merging or deployment.
