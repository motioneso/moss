# Park Press retained-screen migration

Date: 2026-10-10

Status: Approved audit implementation scope. Draft PR publication is authorized after
review and tests. Merging, deployment and release acceptance remain separate gates.

## Source and intent

Implement the actionable findings in the delivered **Moss design audit and migration
plan** dated 2026-10-10. The user approved implementation of the delivered plan.
This is a repair and alignment of retained screens, not a new module or feature flow.
The original audit baseline is `815fd0342b3489c7a4ed4f17dba49910a5de282b`;
the implementation base is `bc9e76df2caa0f8a2351674786fef2da81db129a`.
Historical fixture screenshots retain their source pins and are not live acceptance.

The current Today composition, runtime tokens and authored shared components provide
the visual reference. Retain Archivo display type, sans body and metadata, at least
11px visible text, readable semantic text colours, bone-paper and warm-charcoal
surfaces, flat ruled editorial sections, and the existing Today contour treatment.
Use shared components before raw classes. Separate decoration from readable text.

## Approved repair scope

- F0: semantic text and size contracts; modal and nonmodal focus lifecycle; complete
  menu and tooltip keyboard operation; settings adapter associations; bounded legacy
  style compatibility; documented component contracts; motion and guard coverage.
- C1-C5: account entry/onboarding/recovery alignment, real label relationships,
  shell keyboard behavior, Today spacing and readable text, Settings layout and
  truthful failed-read states, and retained chat/action-card alignment.
- P1-P4: accessible Task actions and details, Calendar readability and event peeks,
  Workshop dialog/form behavior, and truthful Task/Calendar settings state.
- L1-L3/L6: News and Sports shared visual alignment and narrow layouts, Wellness
  selection/read states and export presentation, utility settings recovery, and
  independent Notifications layout and per-action progress.
- L4/L5/E1: minimal Meetings control alignment, bounded non-brand native review,
  and current Finance R1 defects including dollar-limit read truth and the
  Customize disclosure marker's collision with its shared phone target.

Every finding must first be reproduced or revalidated against current source.
Preservation records, design decisions, source-only risks and test targets are not
automatically defects. Repair behavior only with matching regression coverage.
Unknown reads must not be represented as saved defaults or a successful empty state.
Failures should retain confirmed data where possible and offer appropriate retry.

## Explicit design decisions and holds

- Narrow Calendar is approved: retain Day, Week and Month; give Week and Month
  readable minimum column widths with contained horizontal scrolling on phones; keep
  Day compact. Preserve selected view and its persistence, date navigation, keyboard
  access and event/time semantics. No new view or product flow.
- Meals is not built here. Legacy Food remains held pending its separately approved
  complete desktop/narrow prototype. Job Search remains held for a separate decision.
- Preserve Finance's documented red over-budget badge. Preserve its current Reports
  deep link pending an explicit retirement/compatibility decision; no Reports reskin.
- Preserve the recently approved minimal Meetings workspace and recording pill.
  Do not add a decorative dashboard or setup wizard.
- Native SF/platform controls remain appropriate. Do not change the native artwork,
  serif wordmark or landscape branding until the conflicting dated guidance is
  resolved. Linux source review is not macOS visual or interaction proof.
- Preserve account permissions, approvals, outside-content admission, capture guards,
  RLS, queue payload contracts, financial semantics and other backend behavior.

## Shared contract and ownership

The exact allowlist is
[`2026-10-10-park-press-ownership.csv`](../plans/2026-10-10-park-press-ownership.csv).
Every path has one lane. A reservation does not require editing that path. New test,
fixture, source and committed evidence paths must be registered before creation.
Dedicated consumer skins remain consumer-owned even within `packages/ui`.

F0 publishes a source-pinned, tested additive contract before consumers integrate.
Consumers may inspect and prepare nonconflicting work in parallel, but must retest
against the frozen foundation commit. Changes after freeze are serialized by I0.
I0 owns routing, host integration, manifests, app-map and cross-lane assertions.
Pure styling must not invent feature metadata. Behavioral, navigation or recovery
changes receive truthful declarations in the same eventual PR as their implementation.

## Existing work and safety

Active-PR overlaps are held, even when a previous audit considered them available.
Narrow demonstrably disjoint edits explicitly approved during coordination are
marked `active-disjoint-only` in the ownership manifest and must preserve the active
patch's applicability. No worker replaces a current owner's change or cherry-picks
an external branch without coordinated approval. Finance #3312 is merged in the implementation base.
Scheduled work #3154, Memory #3084 and Today clock #3337 remain active at the initial
freshness check. Exact heads and touched paths are recorded in the adjacent handoff.

Only isolated, non-live validation is allowed. Any database test must use the
repository's `verify-gate` skill and `scripts/run-gate.sh`; no hand-rolled DB command
or existing live service. Do not read secrets. Publish only reviewed/tested draft PRs
within the approved scope; no merge or deployment. Keep evidence public-safe and use `~/Jarv1s`
when a local checkout reference is necessary.

## Acceptance

Run focused behavioral tests, root/tests/web typechecks, scoped lint/format and the
applicable design/static guards. Record exact exit codes and not-run stages. Check
representative 320/390px and desktop layouts, Forest light/dark and Teal surfaces,
keyboard entry/Tab/Escape/return focus, reduced motion and interruption/retry states.
Fixture rendering proves only its stated inputs. Real-data installed live UI proof
under the repository's Live-Path Gate is separately required before merge or Done.
Until then, use **code-complete, unverified**, with remaining findings named.
