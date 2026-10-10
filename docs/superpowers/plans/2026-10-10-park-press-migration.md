# Park Press implementation plan

Date: 2026-10-10

Spec: [Retained-screen migration](../specs/2026-10-10-park-press-migration.md)

## Phase 0: reconcile and register

1. Pin current main and all open PRs; identify affected paths before product edits.
2. Commit this spec, plan and exact ownership manifest locally before lane work.
3. Keep active-owner paths blocked and send exact proposed amendments to I0.
4. Register each new source/test/evidence file with one exact owner before creation.

The initial check at 13:06 UTC found main `bc9e76df2`, Finance #3312 merged,
10 open PRs, scheduled integration #3154 at `e206e0a`, and a new #3337 collision
on Today medication formatting. #3154 now also touches shared `components-core.css`
and `check-design-tokens.ts`. The initial snapshot is
[`2026-10-10-park-press-freshness.json`](../handoffs/2026-10-10-park-press-freshness.json).

## Phase 1: freeze additive foundations

F0 owns generic tokens, primitives, adapters, runtime and documentation. Keep APIs
compatible where possible. Establish deliberate modal versus nonmodal behavior,
safe focus entry/restoration, declared menu keyboard handling, label/hint association,
semantic foreground/ground pairs and shared phone hit-target ownership. Publish one
foundation contract commit plus exact verification. Active-PR shared paths stay held
unless their owner reconciliation is approved. Do not hide a shared defect with a
consumer-only workaround.

## Phase 2: disjoint retained-screen repairs

- Core worker: C1-C5, preserving scheduled/Memory/Today clock locks.
- Planning worker: P1-P4, preserving scheduled Task capture.
- Lifestyle worker: L1-L3 and L6; retest Today widget consumers after shared skins.
- Meetings/Finance worker: L4, L5 and E1, respecting native and Reports decisions.
- H1/H2: no implementation or aesthetic rewrite.

Start with revalidated readable-text, keyboard, clipped-action and unknown-state
defects. Preserve locally approved Finance and Meetings anatomy. Use frozen public
components rather than copying Today or extending shared files from a consumer lane.
For every repaired behavior, include a focused test and a truthful metadata proposal.

## Phase 3: coordinated local integration

I0 receives each lane's commit, exact file list, resolved/deferred finding IDs,
test exit codes and fixture evidence. Parent approval precedes cross-lane cherry-picks.
Integrate the foundation contract first, then independent consumer commits, then
truthful metadata/host amendments and cross-surface tests. Re-run consumers after
any contract change or conflict resolution. No lane may claim an active-owner file
has been fixed while it remains held. Preserve current upstream fixes on rebase.

Draft PR publication is approved after review and tests. The eventual combined PR (or
serialized lane PRs) must include matching app-map changes and release-note content;
do not publish a behavior change while deferring its declarations to another PR.

## Verification sequence

1. Focused unit/DOM assertions for each repair, including relevant negative states.
2. Scoped ESLint and Prettier; root/test/web typechecks as applicable.
3. `check:file-size`, `check:design-tokens`, `check:ui-classes`,
   `check:migrated-sections`, `check:ui-catalogue` and `build:app-map`.
4. Source-faithful fixture rendering at desktop and narrow widths with actual shared
   CSS. Record source hashes, viewport, mode, theme and state. Do not call fixtures live.
5. Full static and isolated foundation gate only when tooling permits. DB commands
   must run exclusively through `scripts/run-gate.sh`; record an unavailable Docker
   or toolchain as a blocker rather than attempting the shared/live database.
6. Independent review and the separate real-data live-path gate remain required before
   release acceptance. Browser e2e, CI and native macOS proof have independent status.

## Stop conditions

Pause dependent edits for active-owner overlap, an unfrozen shared contract, missing
authorization, narrow Calendar/native branding/Reports decisions, or unavailable safe validation.
Continue unrelated authorized repairs. Do not create new feature tickets or send
unrequested external messages. Report exact resolved, preserved, deferred,
blocked, passed, failed and not-run outcomes rather than a blanket completion claim.
