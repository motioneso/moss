# JS-140 Notes part eighteen resume

Paused on 2026-11-09 at the user's request for a box reboot. Resume only after
the user releases the pause. Worktree is the task's assigned worktree under
`~/.herdr/worktrees/Jarv1s/`, branch
`task/140-rust-port-phase-5-notes-module-part-18`. Main checkout: `~/Jarv1s`.

## Saved change

Implementation commit: `d4206942e` (`Card: 524`). The task branch was rebased from
its stale Phase 0a starting point to `origin/main` at `3fe2c8ced` before edits.
Experimental create/edit/delete now call `sync_worker::request_source` with the
resolved source, rather than saving an empty checkpoint. The existing worker
refuses pending work after selecting a different folder or unlinking; restoring
the original source allows retry. This checks paths, not replacement-folder identity.
Package version is `0.1.11`; README, changelog, report and module app map are updated.
The legacy write oracle now records sync sources across its existing 55 cases.
The compiled ingestion test now checks folder switching/unlinking for all three
tools and unchanged indexing on refusal, before resuming the original checkpoint.

## Actual verification so far

- Native write regression was observed failing: saved checkpoint was `{}` instead
  of `{"sourcePath":"/notes"}`. The implementation was then changed.
- Native feature-enabled suite passed: 31 tests, including all three write tests.
- Native Clippy with all targets and `-D warnings` passed.
- Legacy corpus generation passed: 55 write and 48 approval cases.
- Scoped ESLint and Prettier passed before the final commit. File-size check passed.
- Full `pnpm typecheck` was terminated for reboot before completion.
- Host-tools compilation and the old-component wrapper build were terminated for
  reboot. No compiled database gate, SQL parity gate, review, proof artifact, PR,
  live browser or second-device check has been completed in this task. Never
  treat the report's description of test coverage as a passing receipt.

## Resume work

1. Confirm branch/tree state and read the part-eighteen section of
   `docs/superpowers/specs/2026-11-08-rust-phase5-notes-report.md`.
2. Prepare task-owned Cargo/Rust homes and build ordinary and write-tools guests
   in separate targets, following `modules/notes/README.md`. The declared
   `wasm32-wasip2` target and approved pinned `wit-bindgen` 0.57.1 were prepared
   only in scratch storage; no global installation was made. JavaScript
   dependencies were restored with `pnpm install --frozen-lockfile`.
3. Run Notes gates only through `scripts/run-gate.sh` using the verify-gate skill.
   Supply both `NOTES_COMPONENT` and `NOTES_TOOL_COMPONENT`. Finish the compiled
   folder-switch/unlink regression, checkpoint privacy removal controls and SQL
   parity gate. Preserve failed and passing receipts separately. Fix any findings.
4. Complete project checks, then arrange Claude read-only review against the base
   and `~/.config/herdr-core/templates/reviewer.md`. Review is on, major and up
   must be fixed, at most two rounds. Zero rounds have been used/recorded. Run
   the model picker; Claude is the required reviewer CLI (Sonnet was the highest
   Claude option when checked). Record each reviewed commit with herdr-task.
5. Publish the recipe proof with a clear Not proven list, create the checkpoint
   PR with Part of issue 4027 and Release note Category N/A, then run herdr-task
   ready only after verification/review. Preserve the task's broader unfinished
   acceptance list; installed chat and production sync remain disabled, and
   full UI/physical second-device HTTPS acceptance is not established.

All task tracking uses `~/.local/bin/herdr-task` with
`--folder ~/Jarv1s`; the brief explicitly says not to touch Vikunja cards.
Do not merge. Current scope is a bounded checkpoint because full Notes acceptance
exceeds a single context window. The user explicitly authorized the reboot push.

## Optional surviving scratch state

Scratch root was `/tmp/js140-notes` (it may be removed by reboot). Task-owned homes
were its `cargo` and `rustup` folders. Targets were `domain`, `host` and
`guest-red`; the latter compiled the old core guest before the fix, but its
component wrapper did not complete. Logs were `red-native.log`,
`green-native.log`, `clippy-native.log`, `host-build.log`, `red-component.log`,
`typecheck.log`, and `file-size.log`. No gate containers or dev servers were started.
