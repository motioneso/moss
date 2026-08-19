# Relay 8: #1512 notes-path-recheck — write & run the UAT spec, post live-path proof

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` — read ONLY the
"Live-path gate" / "Residual risk" sections AND the "Addendum (relay 8)" section at the end
(has the Coordinator-approved scope, quoted in full below — you don't need to re-read the plan
for scope, only for exact section wording if needed).
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, this worktree.
Coordinator: resolve fresh by label "Coordinator" (pane id reflows — do not reuse a baked id).

## State: all 7 QA remediation findings DONE and pushed. Live-path scope is Coordinator-APPROVED
(commit `1a3b3d890`, pushed). **I have NOT yet replied to the Coordinator's approval message** —
do that as your first action (see "First action" below).

Working tree is clean, nothing uncommitted. No code written yet — pure scoping/research so far.

## Approved scope (Coordinator ruling, do not re-litigate)

Live UAT proof, all via real chat on a live dev/UAT instance:
- **(a)** legitimate in-root create/edit/delete/sync succeeds.
- **(b)** `rejectSymlinkParent` (`write-tools.ts:124-141`, pre-existing ancestor-dir lstat check,
  NOT part of #1512's fix) refuses live via real chat.
- **(c')** the ACTUAL #1512 guard (`recheckInside` → `recheckWithinRoot` →
  `canonicalizeAsFarAsExists`, `path-guard.ts`) refuses live via real chat. Trigger: pre-seed
  `$ROOT/S -> /tmp/<outside-dir>` and `$ROOT/b.md -> "S/../evil.md"` inside the UAT container's
  vault volume, then ask the assistant via real chat to create a note at `b.md`. Deterministic,
  no race — fires at `write-tools.ts:189` (`recheckInside(root, file)` before `open(file,"wx")`
  in the non-overwrite branch). Expect `HttpError(400, "path is not within the linked notes
  source")`, no host path leaked. This is `tests/integration/notes.test.ts:98-105`'s case, made
  live.
- **Only narrow test-only carve-out**: `jobs.ts`'s `collectMarkdownFiles` (lines 100-135) is
  Dirent/lstat-based and silently excludes symlinks from the sync-worker's `readdir` walk, so a
  symlink swapped in *after* the walk but *before* the loop reaches it is a genuine
  readdir→realpath TOCTOU race with no deterministic UI trigger. Proven instead by re-running
  `tests/integration/notes.test.ts` fresh and citing output. **Do not generalize this
  "unforceable" language to (b) or (c') — those ARE live-forceable and must be proven live.**

## First action

Reply to the Coordinator (re-resolve pane by label "Coordinator" fresh, do not reuse any prior
pane id): "Relaying to a successor in the same worktree/branch to finish the live-path proof —
scope ruling received and applied to the plan (commit `1a3b3d890`), UAT spec not yet written.
Successor will post the proof comment and ping you." Then proceed with the rest of this doc.

## Concrete next steps

1. **Resolve the chat-UI failed-tool-execution assertion pattern** (was mid-investigation when
   this relay fired). Read `apps/web/src/chat/message-row.tsx` around line 188 (`role="status"`)
   and `apps/web/src/chat/chat-drawer.tsx` around line 755 (`kind === "tool" | "status" |
   "action_result"`) to find how a REFUSED tool call renders (vs. the exemplar's successful
   `"Executed: notes.create"` status text) — needed for (b)/(c') assertions.
2. Write `tests/uat/specs/notes-path-recheck.uat.spec.ts`, modeled on
   `tests/uat/specs/notes-default-retrieval.uat.spec.ts` (signIn/ensureRealChat/uatLevel/
   NOTES_ROOT=`/data/vaults/${UAT_ADMIN_ID}` patterns). For (b)/(c') symlink seeding: `/data/vaults`
   is a **named Docker volume**, not host-mounted — seed via `execFileSync("docker",
   buildUatComposeArgs(projectName, ["exec", "-T", "jarv1s", "sh", "-c", "ln -s ..."]))`, following
   the pattern in `tests/uat/specs/finance-shared.uat.spec.ts` (imports `buildUatComposeArgs` from
   `../provisioner.js`, reads `process.env.JARVIS_UAT_PROJECT_NAME`).
3. Add a row to `.claude/skills/coordinate/uat-trigger-map.tsv` for this new spec.
4. Run `pnpm test:uat notes-path-recheck`, capture full unpiped output + exit code.
5. Re-run `pnpm vitest run tests/integration/notes.test.ts` fresh, capture unpiped output, for the
   jobs.ts TOCTOU-sliver citation only (see scope note above — don't over-claim).
6. Re-read `docs/DEVELOPMENT_STANDARDS.md` → "Live-Path Gate" if needed: no screenshots,
   executable assertions + bounded textual evidence, redact any host paths.
7. Post proof: `gh pr comment 1671 --body-file <tmpfile>` (NOT `gh pr edit` — known to silently
   fail on this repo, see project memory `gh-pr-edit-body-silently-fails.md`).
8. Reply to Coordinator: PR #1671 proof posted, re-QA needed, not merging/closing/moving board.
9. If a live instance genuinely can't be gotten running, say "code-complete, unverified" plainly.

## Do NOT

- Merge, close #1512, or move the board.
- Re-fix any of the 7 already-addressed QA findings.
- Use screenshots for the live-path proof.
- Generalize the jobs.ts "unforceable TOCTOU" language to (b) or (c') — both are live-forceable
  and the Coordinator will reject a comment that soft-pedals them as race-only.
- Silently re-scope again without Coordinator sign-off.
