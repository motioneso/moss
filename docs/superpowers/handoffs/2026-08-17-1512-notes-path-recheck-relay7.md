# Relay 7: #1512 notes-path-recheck — live-path proof only

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` — read ONLY "Live-path gate"
and "Residual risk" sections (lines ~153-183), not the whole doc.
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, this worktree.
Coordinator: resolve fresh by label "Coordinator" (do not reuse any baked pane id — reflows).

## State: all 7 QA remediation findings DONE and pushed (commit `b0b3077e3`). Only live-path proof remains.

No code changed this relay — pure research/orientation (read `path-guard.ts`, `write-tools.ts`,
`jobs.ts`, the plan's two sections, the exemplar UAT spec). Working tree is clean.

## Key scoping finding (resolve this before writing the UAT spec — do not silently skip)

The plan's suggested trigger for the deliberate `NotesPathError` case ("point the assistant at a
path outside the configured root") **does not reach the code path it claims to prove**:
`requireMarkdownPath()` in `write-tools.ts:27` synchronously rejects absolute/`..`-traversal paths
with a *different*, earlier `HttpError(400, "path must be a relative Markdown path")` — before
`path-guard.ts`'s `NotesPathError`/`recheckWithinRoot` (the actual #1512/`f717fe4c3` fix) is ever
reached.

Two real, deterministic (non-racy), chat-reachable ways to trigger the ACTUAL target message
`"path is not within the linked notes source"`:
1. **`rejectSymlinkParent()`** (`write-tools.ts:124`) — pre-seed a symlinked ancestor directory
   inside the notes root, then ask the assistant via chat to create/edit a note through it. Fires
   synchronously, no race. Same generic message, but this is `write-tools.ts`'s own check, not
   `NotesPathError`/`sanitizedErrorMessage` in `jobs.ts`.
2. The actual `NotesPathError` → `sanitizedErrorMessage()` → persisted `notes-last-sync.lastError`
   chain (the literal `f717fe4c3` fix) only fires on a genuine TOCTOU race inside the sync job's
   per-file loop (swap a real file/dir for a symlink between the initial `readdir` walk and the
   loop reaching it) — inherently timing-dependent, not cleanly forceable through pure UI action.
   Also note: `collectMarkdownFiles` uses lstat-based `Dirent` info, so a symlink placed in the
   root *before* sync starts is silently excluded from the walk (no error at all), not a trigger.

**Recommended resolution** (present to Coordinator for approval, don't just decide solo): live UAT
proof covers (a) legit in-root create/edit/delete/sync via real chat, succeeding, and (b) the
`rejectSymlinkParent` refusal live via real chat, confirming the generic message with no host path
in the `notes-last-sync`/tool-error response — **plus** an honest note in the PR comment that the
specific `NotesPathError`/`sanitizedErrorMessage` chain is proven by the existing
`tests/integration/notes.test.ts` `recheckWithinRoot`/symlink-escape unit tests (already green,
re-run and cite fresh output) because true live reproduction requires an unforceable TOCTOU race.
This is not a gap being hidden — say it plainly in the PR comment.

## Concrete next steps (per `coordinated-build`)

1. Write plan addendum or short plan note for the UAT spec (via `plan-build` skill conventions)
   covering the above scope decision.
2. **Message Coordinator, wait for approval** before writing code — do not skip this gate.
3. Write `tests/uat/specs/notes-path-recheck.uat.spec.ts`, modeled on
   `tests/uat/specs/notes-default-retrieval.uat.spec.ts` (full exemplar already read this
   session — reuse its `signIn`/`ensureRealChat`/`uatLevel`/`NOTES_ROOT =
   /data/vaults/${UAT_ADMIN_ID}`/chat-composer/`GET /api/me/notes-last-sync` polling pattern).
4. Run `pnpm test:uat notes-path-recheck` (real chat works automatically via the already-set
   `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` env var — no manual provider setup needed). Capture unpiped
   output + exit code.
5. Re-run `pnpm vitest run tests/integration/notes.test.ts` fresh, capture unpiped output, for the
   `NotesPathError`/`recheckWithinRoot` bounded textual evidence per point 2 above.
6. Read `docs/DEVELOPMENT_STANDARDS.md` → "Live-Path Gate" section (authoritative, supersedes the
   relay/plan's screenshot suggestion): **no screenshots** — executable assertions + bounded
   textual evidence only. Never paste literal host paths or outside-root content — redact.
7. Post proof via `gh pr comment 1671 --body-file ...` (`gh pr edit` silently fails on this repo).
8. Report to Coordinator: PR #1671 proof-complete, re-QA still needed, not merging/closing/moving
   board.
9. If a live instance genuinely can't be gotten running: say "code-complete, unverified" plainly,
   don't fabricate.

## Do NOT

- Merge, close #1512, or move the board.
- Re-fix any of the 7 already-addressed QA findings (`9d66c1309`, `f717fe4c3`, `4d3801d42`,
  `807bdec19`).
- Use screenshots for the live-path proof (superseded guidance — see step 6 above).
- Silently pick the scope resolution above without Coordinator sign-off — it's a real re-scope of
  the plan's stated approach, flag it.
