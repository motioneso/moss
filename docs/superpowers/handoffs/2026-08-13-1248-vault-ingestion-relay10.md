# #1248 vault-ingestion — relay10 continuation

PR #1606, branch `1248-vault-ingestion`, this worktree, HEAD `9cd68b713` (already pushed to
origin — confirmed via `gh pr view`, no push needed). `node_modules` already installed — do not
`pnpm install`. Working tree clean.

Coordinator label: **Coordinator** — resolve fresh via `herdr pane list`, never trust a session-id
below by itself. At relay10 handoff time it was a **codex** agent, session
`019ffd3f-3098-73c0-bab8-31f491615168`, pane `w1:pA1` — re-resolve, don't reuse the pane id.

## Done this relay (relay9, all verified real, not false-green)

1. Gate: clean green `pnpm verify:foundation` against fresh `jarvis_gate_1248vault` — 193 test
   files, 1904 passed, 2 skipped, rc=0. The earlier RED (`briefings-action-rows`,
   `finance-storage-migrate`) was confirmed cluster contention from a **real disk-full crash** of
   shared `jarv1s-postgres` (not just role contention as previously assumed — see memory note
   below), not a #1248 regression. Escalated via `AWAITING-BEN.md` + `needs-ben`, Coordinator
   resolved it (cleanup done, Postgres healthy), verified independently before retrying gate.
2. Pre-push trio: `format:check`/`lint`/`typecheck` all EXIT=0 (root-level, not filtered). Already
   current with `origin/main`, no rebase needed.
3. Pushed `--force-with-lease` (branch had diverged after an earlier relay's rebase). Confirmed via
   `gh pr view` PR #1606 now reflects HEAD `9cd68b713`.

## What's left, in order (unchanged from relay9's list, items 4-5)

**4. Run the 2 blocking UAT specs on a live dev instance, no screenshots.** Not yet started this
relay — I read both spec files but ran nothing.
   - `tests/uat/specs/1217-uat-vault-ownership.uat.spec.ts` — `admin+data` level. Logs in, opens
     chat drawer, uploads a file via `.chatd-attach__input`, asserts `POST /api/chat/attachments`
     returns 201 with a UUID id, exact filename, exact size. Real assertion: seeded actor's vault
     dir must be writable (regression was root-owned vault dir from seed running as root).
   - `tests/uat/specs/module-install.uat.spec.ts` — `admin+data` level, `without: ["finance"]`
     (so Finance starts uninstalled). Logs in, opens Settings → Admin/Setup → Instance modules,
     installs Finance, asserts it reaches installed-enabled after a **real restart**. I read only
     the first ~40 lines (import, uatLevel, login, nav helper) — read the rest before running it.
   - Harness: `pnpm test:uat <filter>` (`tests/uat/run-uat.ts`), NOT the root `playwright.config.ts`
     (that's mocked-API, not live-path evidence). It provisions a real ephemeral Docker stack via
     `tests/uat/provisioner.ts`, sets `JARVIS_UAT_BASE_URL`, runs against
     `tests/uat/playwright.uat.config.ts` (`screenshot: "off"` already — good, but confirm no
     screenshot artifact lands anywhere before posting proof). `JARVIS_UAT_BUILD=0` reuses the
     image if you iterate. No "keep stack" flag exists — teardown always runs, so capture bounded
     evidence (assertion output, a scoped `psql` query, relevant log lines) **during** the run, not
     after. See memory `uat-spec-gotchas`, `uat-reload-poll-and-psql-seed-traps`,
     `uat-spec-psql-role-trap` (always `-U postgres`, never `jarv1s`), `dev-preview-recipe` for
     mechanics/traps before running.
   - **No screenshots** — permanent Coordinator policy (commit `6ecdc2a66`). Do not generate,
     capture, attach, or preserve any. If Playwright produces one as a side effect (e.g. a failure
     trace), delete it before any commit/comment. Live-path rigor itself is unchanged — must still
     be the real UI on a real stack, just proved via exit code + bounded DOM/network/log/DB
     evidence instead of images.
   - Suggested command to start with: `pnpm test:uat 1217-uat-vault-ownership module-install`
     (check `resolveSpecPaths` filter matching in `run-uat.ts` — substring match on basename works).

**5. Post live-path proof + message Coordinator.** Per `coordinated-wrap-up` skill's "Live-path
proof" section, adapted for no screenshots: `gh pr comment 1606` with exit codes + bounded evidence
for both specs. Then `herdr-pane-message` the Coordinator (re-resolve label fresh) with new HEAD
sha (`9cd68b713`, unchanged since this relay didn't push) + the proof-comment link, ready for
re-QA. **Never merge/board/close yourself.**

Also at your discretion (non-blocking): PR #1606's QA verdict comment has 8 non-blocking notes,
not yet read/actioned.

## Explicitly NOT your job

- `chat-drawer-surface.test.tsx` CI flake, #1607 — someone else's, already escalated to Fable via
  Coordinator. Don't re-investigate.

## Note for memory (not yet written — do it once this relay has headroom, or next relay)

The relay8 handoff's diagnosis of gate RED as "cluster-global Postgres role contention" (citing
memory `pg-roles-are-cluster-global`) turned out on this relay to actually be a genuine **disk-full
crash** of shared `jarv1s-postgres` (PANIC on checkpoint write, `No space left on device`, failed
recovery). The role-contention pattern may still be real in other cases, but don't assume it's the
cause of a same-symptom RED without checking `docker ps -a` / `docker logs jarv1s-postgres` first —
worth a `memory_save` distinguishing the two failure modes so the next relay doesn't skip that
check.
