# Relay 2 — #1037 chat-resume RLS test — build DONE, wrap-up remaining

**Spec/plan:** `docs/superpowers/plans/2026-08-16-1037-chat-resume-rls-test.md` (self-contained,
already committed). **Issue:** #1037. **Risk tier:** security. **Branch:**
`1037-chat-resume-rls-test` (this worktree). **Coordinator label:** `Coordinator` — verify
`herdr pane list` shows exactly one pane with this label before messaging.

## Status: build complete, gate green. Only `coordinated-wrap-up` remains.

Commits on this branch (in order, all present, nothing to redo):
1. `ade52cb7d` — `test(#1037): chat-resume RLS regression test` — new file
   `tests/integration/chat-resume-privacy.test.ts`, 2 tests (actor B denied 404 + no row
   disruption; actor A owner positive control 204). **Both passed on the first honest run** — no
   RLS gap, kill gate cleared, nothing to escalate.
2. `f2e2732a1` — `style(#1037): prettier-format the committed plan doc` — pre-existing
   `format:check` red in the prior (already-committed) plan doc, fixed as a separate whitespace-only
   commit (verified pure-formatting diff before committing).

Verification already done, do not re-run unless you have reason to distrust it:
- `pnpm test:integration tests/integration/chat-resume-privacy.test.ts` → `EXIT=0`, 2/2 passing.
  (Needed `pnpm build:app-map` first when run standalone — `dist/app-map.json` doesn't exist until
  that runs; the full gate below does this itself.)
- Pre-push trio: `format:check` / `lint` / `typecheck` all `EXIT=0` (after the prettier fix above).
- `git fetch origin main && git rebase origin/main` → already up to date, nothing to rebase.
- **Full gate, ran isolated** (`JARVIS_PGDATABASE=jarvis_gate_1037chatresume`, dropped after):
  `pnpm verify:foundation` → `### FINAL rc=0`. 197 test files / 1919 tests passed, 2 skipped.
  Gate DB already dropped — don't need to clean up.
- Ran concurrently with #1038's own gate run against the same Postgres container; no crash, no
  `tuple concurrently updated` — the #1013/#1639 cluster-DDL-lock fix held under concurrency.

## Next steps (only remaining work)

Invoke `coordinated-wrap-up` directly — build is done, nothing to plan or re-verify:
1. Confirm tree is clean (`git status` — should be clean, both commits already made).
2. Push branch: `git push -u origin 1037-chat-resume-rls-test`.
3. Open PR against `main`. Body must state explicitly: **this is an internal-only test change (no
   production code touched), no live-path UI proof needed** — per the original handoff and the
   plan's Non-goals section. Reference #1037. Summarize: adds a regression test proving the
   resume-thread route's RLS-only ownership check (no app-level `owner_user_id` filter) still holds;
   kill gate cleared on first run; plus one pre-existing formatting fix to the plan doc.
4. Report the PR URL + verified evidence (gate rc=0, test rc=0, both kill-gate-clear) to the
   coordinator via `herdr-pane-message`. **Do not merge, touch the board, or close the issue** —
   coordinator's call.

## Collision notes (unchanged)

- #1038 (separate worktree `1038-chat-privacy-leak-test`) covers list/detail history endpoints —
  zero file overlap by design.
- Never modify `tests/integration/test-database.ts` (shared fixture, read-only reuse) — not
  touched.
- Never touch `docs/coordination/`, the board, or merge.
