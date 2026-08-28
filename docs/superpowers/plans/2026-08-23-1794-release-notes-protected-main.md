# Build plan: release notes through protected main (#1794)

Spec: `docs/superpowers/specs/2026-08-23-1794-release-notes-protected-main.md`
Issue: #1794

## Seams check

- `scripts/append-release-note.mjs:34-48` already parses the unchanged pull-request release-note
  schema and returns `null` for `Category: N/A`; preserve that contract.
- `scripts/append-release-note.mjs:54-96` is the existing pure markdown transformation seam. It
  currently treats `## Edge channel — <date>` as one mutable section, so later calls overwrite the
  date. The replacement keeps this function pure and makes date groups explicit.
- `scripts/append-release-note.mjs:98-160` is the existing focused self-check seam. Extend it for
  first-day, same-day, later-day, N/A, and two-input retention cases; no test dependency is needed.
- `scripts/append-release-note.mjs:162-200` already accepts pull-request metadata through
  environment variables or `--pr`; the workflow will use environment variables so event text is
  not interpolated into shell source.
- `.github/workflows/ci.yml:3-8,57-90` proves pull-request workflows and markdown-only checks are
  available; `.github/workflows/edge-publish-alarm.yml:35-70` proves `gh api`/`GH_TOKEN` workflow
  automation is already used. The protected-main ruleset itself is external GitHub state, so the
  workflow will use a non-main branch and a pull request as the only write path.
- `docs/WHATS_NEW.md:26-30` is the current edge-channel format to migrate on the first append;
  `apps/web/src/settings/settings-released-pane.tsx` consumes the document as raw markdown, so
  no parser contract needs changing.

## Decisions

- Keep the existing release-note schema and Node standard-library implementation.
- Make the Edge channel a stable `## Edge channel` section containing descending `### YYYY-MM-DD`
  date groups, each with `#### Added`, `#### Fixed`, and `#### Changed` headings. The transformer
  accepts the current `## Edge channel — <date>` shape for a clean first migration.
- Detect an existing `[PR #N]` link in the target Edge channel and leave the document unchanged;
  retries then cannot duplicate a note.
- Serialize workflow runs with `concurrency.cancel-in-progress: false`, and always merge the latest
  `origin/main` into the dedicated release-note branch before appending. This makes concurrent
  merged PR events queue instead of racing or dropping a branch update.
- The workflow writes only `automation/release-notes`, then creates or updates one PR targeting
  `main`. It never pushes `main`, closes PRs, or bypasses required checks.

## Phase 1 — transformer and self-check

Files: `scripts/append-release-note.mjs`, `docs/WHATS_NEW.md`.

1. Refactor the existing append seam to preserve prior date groups, append under the current
   Pacific date, create category headings in canonical order, and migrate the existing edge
   heading without altering stable history.
2. Keep `parseReleaseNote` and its N/A behavior unchanged; make duplicate PR application a no-op.
3. Extend `--self-test` with assertions that would fail for the old implementation: first entry
   creates a date group; a second entry on that date stays in that group and category; a later date
   creates a second group while retaining the first; N/A produces no note; applying two distinct
   inputs in sequence retains both links (the reducer invariant used by the serialized workflow).
4. Update the checked-in edge section to the canonical shape if the transformer requires a fixture
   migration; do not add a historical release entry.

Verification: `node scripts/append-release-note.mjs --self-test` (exit 0). Kill gate: if the
self-check cannot preserve both existing and newly appended date groups without a special-case
fixture, stop phase 2 and escalate to the coordinator for a shape decision.

## Phase 2 — protected-main workflow and process text

Files: `.github/workflows/release-notes.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CLAUDE.md`.

1. Add a workflow for merged pull requests targeting `main`, guarded by the merged predicate, with
   least-privilege `contents: write` and `pull-requests: write` permissions and a serialized
   `release-notes` concurrency group.
2. Check out/fetch `main`, create or update `automation/release-notes`, merge current `origin/main`,
   run the self-check, and invoke the transformer with event metadata passed as environment values.
   Commit only `docs/WHATS_NEW.md`; skip the commit when N/A or an idempotent retry produces no
   diff. Push the automation branch and use `gh` to create or find its open PR against `main`.
3. Update the PR template and CLAUDE release-process wording so contributors know the workflow
   owns the generated PR and no longer instructs manual branch edits. Keep the N/A instruction.

Verification: `pnpm format:check` (exit 0), `pnpm lint` (exit 0), and `pnpm typecheck` (exit 0).
The acceptance proof is a real merged test PR after this change: the workflow run must retain both
notes from queued inputs, leave `main` untouched except through the generated PR, and show the
generated PR passing CI without bypass credentials. The coordinator owns that merge-last proof.

## Exit criteria

- Self-check covers first date, same-date append, later date, N/A, duplicate retry, and two-input
  retention.
- Workflow queues concurrent merged-PR events, updates one dedicated branch/PR, and has no direct
  `main` push or bypass path.
- Template and CLAUDE describe the protected-main process accurately.
- Focused checks and the isolated full gate pass; coordinator records the real merged-PR proof.
