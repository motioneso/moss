# Relay 7 — #1188 connector onboarding (real-dev UI evidence, script written not yet run)

Context meter hit 70%. Relaying per `relay` skill immediately, before running the capture
script (never got to execute it this relay — don't re-derive, just run it).

**Spec:** `docs/superpowers/specs/2026-07-19-1188-connector-onboarding-feedback.md`
**Worktree/branch:** same, `fix/1188-connector-onboarding-clean` (worktree
`feedback-1188-connector-onboarding`).
**PR:** https://github.com/motioneso/Jarv1s/pull/1206 — **DO NOT MERGE.**
**Coordinator:** label `Coordinator` — re-resolve pane fresh by label via `herdr pane list`
(never trust a pane number baked into any doc, including this one).
**Full task list:** read `docs/superpowers/handoffs/2026-07-19-1188-connector-onboarding-relay-6.md`
in full for the original ask/precedent (#995 README format) — this doc only covers delta
since then.

## What's done this relay

1. Read relay-6 in full. `node_modules` confirmed present, tree clean (only
   `.claude/context-meter.log` dirty, ignore it).
2. Isolated dev DB created + migrated clean:
   `jarv1s_uidemo_1188` (drop/create + `pnpm db:migrate` — all migrations applied, 0 errors).
3. **Dev servers are UP right now, still running in the background** (do NOT re-launch, just
   reuse them — check with `ss -ltnp | grep -E ':3902|:5179'` first):
   - API: `JARVIS_PGDATABASE=jarv1s_uidemo_1188 PORT=3902` → log `/tmp/cb-api-1188.log`
   - Web: `JARVIS_API_PROXY_TARGET=http://localhost:3902` vite on `5179` → log
     `/tmp/cb-web-1188.log`
   - If either died, restart exactly per relay-6's "Start servers" block, same ports/DB.
   - **Stop when fully done:** `lsof -ti:5179 -sTCP:LISTEN | xargs -r kill; lsof -ti:3902
     -sTCP:LISTEN | xargs -r kill`.
4. Read the real (non-mocked) UI source to plan the driver script — key findings, don't
   re-derive:
   - Fresh DB → `/` shows `AuthScreen` (`apps/web/src/auth/auth-screen.tsx`) in owner-bootstrap
     mode: `#auth-title` heading, name/email/password inputs (name input is
     `input[autocomplete="name"]`), submit button `button[type="submit"]`.
   - Founder onboarding rail order: `welcome` → `cliAuth` (label "Assistant") → `connectors`
     (label "Google") → `finish`. "Start setup" on welcome, "Continue" on cliAuth to reach the
     connectors step.
   - Connectors step = `GoogleConnectorStep`
     (`apps/web/src/onboarding/google-connector-step.tsx`). Provider picker renders `.onb-prov`
     buttons — Google first, then 4 IMAP providers (Yahoo/Proton/iCloud/Fastmail), all same
     `.onb-prov` class = the equal-visual-weight fix (`fe2a0c6d`).
   - IMAP click → `mode="imap"`, shows numbered `.onb-guide__step` list, help link
     (`{Provider} setup guide`) nested inside the **last** step only — the `a382c8ac` fix.
   - Google click → `mode="connecting"`. "Open consent screen" button is disabled until
     `clientId` (>8 chars) and `clientSecret` (>6 chars) filled — fill fake values first. Click
     triggers `window.open("about:blank", ...)` synchronously (one-click consent, `9d077038`)
     then POSTs `/api/connectors/google/authorize`; popup navigates once `authUrl` resolves. No
     real Google creds in dev — popup erroring/blank past the initial open is expected, not a
     regression; note it plainly in the README.
   - The add-account-picker-not-collapsing bug (`c2f56e66`) only reproduces with an **existing**
     connected account, and real IMAP/Google connect both require a live probe/OAuth
     round-trip that will fail without real creds. Chosen workaround: legitimately seed one
     account via the real authenticated `POST /api/connectors/accounts` endpoint (server-side
     AES-256-GCM encrypts `tokenPayload` — this is a real app endpoint, not a DB hack), then
     reload and click "Connect another account" to prove the picker re-renders instead of
     collapsing back to the connected summary.
5. **Wrote the throwaway driver script**: `tests/uat-scratch/uat-manual.mjs` (Playwright via
   `@playwright/test`'s `chromium` launcher — `chromium-cli` is **not installed** in this
   container, confirmed via `command -v chromium-cli` → not found, and no global/npm package
   either; the `run` skill's playwright fallback pattern applies, which is exactly what #995 did
   too — see its README, "Ran via a throwaway local script"). The script is fully written,
   records numbered DOM/state assertions `00` through `04` + `02a` into
   `docs/superpowers/handoffs/2026-07-19-1188-uat-evidence/`, and prints console errors +
   the seed-account API response to stdout. **It has NOT been executed yet.**

## Next concrete steps (in order)

1. **Run the script:**
   ```bash
   cd /home/ben/Jarv1s/.claude/worktrees/feedback-1188-connector-onboarding
   node tests/uat-scratch/uat-manual.mjs
   ```
   Watch stdout for `UAT SCRIPT FAILED` — if a selector doesn't match (UI may differ slightly
   from what was read), open `/tmp/cb-web-1188.log` and adjust the script in place; the
   sequence/selectors documented above are accurate as of this relay's reading but the script
   itself is unverified end-to-end. Confirm all assertion artifacts actually landed in
   `docs/superpowers/handoffs/2026-07-19-1188-uat-evidence/` before moving on. Re-run freely —
   it's idempotent enough (reseeding a second account is harmless; if you want a clean single
   seed, `DROP DATABASE`/recreate/re-migrate first — commands above).

2. **Check `console --errors`-equivalent output** (the script's `ALL_CONSOLE_ERRORS` stdout
   line) — note any errors in the README even if expected (e.g. missing OAuth client id
   round-trip past the popup).

3. **Delete the throwaway script** (`rm tests/uat-scratch/uat-manual.mjs`, and `rmdir
   tests/uat-scratch` if now empty) — never intended to be committed, matches #995 precedent.

4. **Write `docs/superpowers/handoffs/2026-07-19-1188-uat-evidence/README.md`**, modeled
   exactly on `docs/superpowers/handoffs/2026-07-15-995-uat-evidence/README.md`'s structure
   (ports/DB/PR-HEAD-sha header line, then a checklist-item → assertion table). Map assertions
   to the actual #1188 checklist (see relay-6 §"Screens to capture" — provider picker equal
   weight, add-account picker not collapsing, Google one-click consent popup attempt, IMAP
   nested help link, console-errors note). Use PR HEAD sha `f1c27cfe` (current tip; re-check
   `git rev-parse HEAD` in case a later commit landed) and ports 3902/5179, DB
   `jarv1s_uidemo_1188`.

5. **Commit + push** to `fix/1188-connector-onboarding-clean` (new commit, e.g.
   `docs(onboarding): #1188 real-dev UI evidence`). Confirm `git status` clean of anything else
   first (only the evidence dir + README, script already deleted).

6. **Poll CI once more** before reporting — last snapshot this relay (may be stale by the time
   you read this, re-run): `gh pr checks 1206 --json name,bucket,state` showed
   `Prod compose deployment smoke`=pass, `Compose deployment smoke`=pass, `Verify foundation and
   app`=IN_PROGRESS (a GitHub-triggered rerun, not something this session started — does not
   violate the gate lock). **"Build and publish images" was not present in the checks list at
   all in this snapshot** — re-check; if still absent, note that plainly to Coordinator rather
   than guessing why.

7. **Post evidence in the PR**: `gh pr comment 1206 --body "..."` with the bounded DOM, network,
   console, and API assertion results.

8. **Report to Coordinator** via `herdr-pane-message` (label `Coordinator`, re-resolve pane
   fresh — never trust a baked-in number): link the PR comment, restate VF_EXIT=0/AUDIT_EXIT=0
   from the prior (already-green) gate run, the CI "Build and publish images" status from step
   6, and explicitly restate **not merged, awaiting Coordinator**. Then stop.

## Governing instructions (most recent wins, all still active)

1. Report PR URL to Coordinator, **do not merge** — reaffirmed multiple times, most recently
   with this evidence request. Treat as absolute.
2. Log paths must stay session/worktree-unique (`/tmp/cb-*-1188.log` convention) — never a bare
   shared path like `/tmp/cb-vf.log` (fleet trap, hit previously this run).
3. Gate lock: do NOT start any NEW full `verify:foundation` run without Coordinator release.
   Running the capture script / driving the dev servers is a targeted manual UI check, not a
   gate rerun — fine under the lock.

## Self-monitor reminder

Relay again immediately on the next context-meter 70% warning — don't wait to finish all
remaining steps in one session. This relay burned its budget on research/script-writing with
zero execution — the successor should get straight to running the script as step 1, not
re-reading source it doesn't need to.
