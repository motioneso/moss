# Relay — #903 sports primary-follow tie-break (2nd relay)

- Issue: #903. Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` (#903 row).
- Plan: `docs/superpowers/plans/2026-08-08-903-sports-primary-follow-tiebreak.md` — has the exact
  "Live-path proof" scenario wording, don't re-derive.
- Worktree/branch: this worktree, `fix-903-sports-tiebreak`. Tree is clean, HEAD `fc0c757b6`.
- Coordinator: Herdr label `Coordinator` — resolve pane fresh by label + **session id
  `019fe36a-3d6c-7cd3-9338-3ed739fca2f1`** (superseded from an earlier id mid-run; this is current
  as of this relay). Never a baked `…-N`.

## Done

- Fix commits `02fff920c` (code) + `b53c94fd8` (plan doc), rebased clean on origin/main.
- Isolated gate ran via `scripts/run-gate.sh` (gate DB `jarvis_gate_fix_903_sports_tiebreak`,
  log `/tmp/jarv1s-gate/fix_903_sports_tiebreak-20260808-143637.log`): lint/format:check/typecheck/
  unit all green (529 files, 4258 tests passed). `test:integration` had scattered `FAIL`s
  (`error: tuple concurrently updated`) in unrelated modules (job-search, mcp-gateway, imap,
  multi-user-isolation, notes) — confirmed via grep **zero sports-related failures** — this is the
  documented cross-worktree DDL-contention exception in `coordinated-wrap-up`, not our bug. Did
  NOT re-run locally per the skill's explicit instruction; disclosed transparently in the PR body.
  Gate DB left in place (kept-on-failure by script design, scratch DB, not the shared dev DB).
- Pre-push trio fresh green: `format:check`/`lint`/`typecheck` all EXIT=0.
- **PR #1472 open**: https://github.com/motioneso/moss/pull/1472 — body has scope, verification
  exit codes, and the gate-contention caveat. Placeholder live-path section says a proof comment
  will follow.

## Left to do — this is the entire remaining task

1. **Live-path proof** (required — this is user-facing, `docs/DEVELOPMENT_STANDARDS.md` →
   Live-Path Gate). No automated UAT spec covers sports (`uat-trigger-map.tsv` has no matching
   row — confirmed empty), so this needs a **manual live-UI walk**, not a headless test run.
   - No usable live dev instance currently exists for this worktree. (The one listening on
     `:5173` belongs to a different, already-torn-down worktree — don't touch it.)
   - Free ports picked for a fresh instance of THIS worktree: **API `:3099`, web `:5199`**
     (confirmed free via `ss -ltn` as of this relay — recheck, another lane may have taken them).
   - No explicit Postgres env vars needed — `packages/db/src/urls.ts` defaults to
     `localhost:55433` db `jarv1s` (the shared dev DB) automatically.
   - LAN IP for trusted origins: `192.168.50.36` (`enp5s0`). Follow the
     `dev-instance-lan-spinup-trusted-origins` memory's recipe for
     `JARVIS_AUTH_TRUSTED_ORIGINS` / `JARVIS_API_PROXY_TARGET=http://localhost:3099` /
     `BETTER_AUTH_SECRET`.
   - Drive with `chromium-cli` per the `run` skill's `examples/playwright.md` (was mid-checking
     `which chromium-cli` availability when this relay was triggered — check it fresh). Fallback
     if unavailable: adapt `_electron`-style Playwright REPL per that doc (`chromium.launch({args:
     ['--no-sandbox']})`).
   - Sign in as `ben@ben.com` / `jarvistest123!` (dev seed user).
   - Follow two competitions via the real UI. Natural clicks won't produce an exact `created_at`
     tie — force it with a direct `psql` `UPDATE` against the two new follow rows (record both row
     ids for teardown!), then reload multiple times and screenshot to confirm the **same**
     competition renders as primary every time (that's the actual regression this fix prevents).
   - Post result as `gh pr comment 1472` per `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate
     format (what was clicked, screenshot, confirms stability across reloads).
   - **If any of this can't be completed** (no live instance reachable, tooling unavailable,
     etc.) — the mandatory fallback is to report status explicitly as **"code-complete,
     unverified"**, never "done". Do not fudge this.
2. `coordinated-wrap-up` step 4: report to Coordinator (label + session id above) — terse,
   result-first, PR link + gate exit codes + live-path status + teardown state. **Never merge,
   close the issue, or move the board** — Coordinator's job.
3. Teardown before reporting: kill anything started for the live-path proof by **explicit PID**
   (never name pattern — prod's worker can look like a stray dev process), delete any DB rows
   seeded/modified by **recorded id** (never reset/truncate the shared dev DB).
4. Optional: `memory_save` (`project: "jarv1s"`) only if something genuinely new and non-obvious
   was learned — check existing gate-contention / live-path memories first to avoid duplicating.

## Notes

- Don't re-run `pnpm install` — `node_modules` already present in this worktree.
- Don't re-read the plan doc or gate log in full — both already summarized above; read by section
  only if you need exact wording.
