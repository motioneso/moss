# Handoff — issue #1504, TLS child 1 (opt-in Caddy profile), relay 1

Original task brief: `~/.coord-briefs/boot-1504-tls-compose-proxy.txt` (still valid, read it first).
Plan (already approved, follow it exactly, no new plan needed):
`docs/superpowers/plans/2026-08-29-1504-tls-compose-proxy.md`.
Worktree/branch: `1504-tls-compose-proxy` (same one, keep using it).
Coordinator: pane label `Coordinator`, session id `acf0c352-67e2-45fa-be98-be893df1099d`, workspace w1.
This is relay 1 — the budget is one relay per Ben's rule. If you also hit the 70% warning without
an open PR, stop and report to the coordinator for a re-slice; do not relay again.

## What is done (all committed, commit 98d4b2dee on this branch)

All three owned files are written and match the plan's Tasks 1-4 exactly:
- `infra/caddy/Caddyfile` — new file, done.
- `infra/docker-compose.prod.yml` — `caddy-init` and `caddy` services added, plus the two new
  named volumes `caddy-data`/`caddy-config`, plus the `setup` service now forwards the two TLS
  variables with empty-safe defaults.
- `tests/unit/prod-deploy-config.test.ts` — new describe block with all 10 test cases from the
  plan's Task 4.

## Manually proven already (do not re-derive, just cite these when you write the PR)

Every one of the plan's "How each acceptance check is proven" commands was run by hand and passed:
- Check 1 (no profile: same 4 services, same `1533:3000` mapping) — exit 0, diff clean.
- Check 2 (`--profile tls` render has none of the forbidden settings) — exit 0, grep exit 1 (nothing found).
- Check 5 issuer half (`caddy validate` with internal/acme/bogus) — exits 0, 0, 1 as expected —
  **but only once the caddy-init ownership fix has run against the two volumes first**. See the
  one real finding below.
- The host guard (test case 9's whole table: moss.lan/internal and 10.0.0.5/internal pass; empty,
  "moss.lan evil.com", a URL, a port suffix, a wildcard, bare and bracketed IPv6, and
  10.0.0.5/acme all fail) — every row matched the plan's table exactly.
- The restart check (finding 10 / test case 10): ran caddy-init, then ran caddy long enough to
  create its owner-only certificate folders, stopped it, ran caddy-init again — second run also
  exited 0. This is the exact regression the plan revision was written to close, and it's fixed.

## One real finding this session made, not in the plan

The plan's finding 7 table says `caddy validate` with the `internal` issuer succeeds at exit 0
with no volumes mounted at all. That is not reproducible here: a brand-new named volume comes
pre-populated by the Caddy image itself with a root-owned `/data/caddy` and `/config/caddy`
directory (mode 755, owner root), so validating with the internal issuer needs to write a new
root certificate into `/data/caddy/pki`, which fails with "permission denied" until caddy-init's
ownership fix has actually run against real volumes first.

This does not change any design decision or file contract — caddy-init already chowns exactly
these two paths (D1's fourth path, `/data/caddy` and `/config/caddy`, was already in Task 2's
contract for the finding-10 restart reason). It only means: **test case 8 and the PR's manual
check-5 command must run caddy-init's chown against real volumes before calling `caddy validate`
with the internal issuer** — validate-in-isolation-with-no-volumes only works for the acme issuer
(which never touches local storage). Test case 8 in the committed test file already does this
correctly (creates two throwaway volumes, runs the chown, then validates). When you write the PR
body's manual check 5 command, mount and pre-chown two volumes the same way rather than pasting
the plan's literal command — the plan's version will fail on a truly fresh volume with the
internal issuer.

## What is left

1. Run the whole test file and get it green:
   `pnpm exec vitest run tests/unit/prod-deploy-config.test.ts > /tmp/1504-vitest.log 2>&1; echo EXIT=$?`
   then read the log with `tail`. Last run before this relay had all manual pieces individually
   verified working, but the full automated file had not yet been run end-to-end after the two
   bug fixes (test case 8's volume-based rewrite, test case 10's stdout encoding fix) — do this
   first, it's the most likely place for a small leftover bug (e.g. a stale volume name colliding
   across two test runs, or a docker network issue — this host runs many other Docker stacks and
   IP pool exhaustion is real; if you hit "pool overlaps with other one on this address space" on
   any `docker compose up`/`run` network create, that's host network exhaustion, not your bug —
   the plan's own manual checks that only use `docker compose ... config` (no `up`) don't create
   networks and are unaffected; only avoid `docker compose up`/`run` on the shared jarv1s network
   for verification — the plan's checks already use `docker run` directly for anything that needs
   a live container, precisely to sidestep this).
2. Run `pnpm exec vitest run tests/unit/prod-deploy-config.test.ts` and fix any remaining red.
3. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
4. Run `pnpm check:file-size`.
5. Run the full gate via the `verify-gate` skill (never bare `pnpm verify:foundation`, never piped).
6. Push, open the PR (fill in the Release note section: Category N/A, per the plan's "Prod safety"
   section — the profile is off by default, nothing user-visible changes yet).
7. On the PR, record every one of the seven checks by name with its exact command and exit code —
   see the task brief's "What you must prove" section and the plan's "How each acceptance check is
   proven" section, adjusted for the one finding above.
8. State plainly on the PR: green and awaiting Child 4's live-path proof from a real second
   device, not ready to merge (per the task brief's "Merge expectation" section — do not expect or
   ask for a merge).
9. Report to the coordinator (`coordinated-wrap-up` skill) with the PR link and the finding above.

## Traps already hit and worked around (don't re-hit them)

- `docker compose ... --profile tls run/up` against the real `jarv1s` network can fail with
  "Pool overlaps with other one on this address space" — this host already runs ~15 other Docker
  Compose stacks. `docker network prune -f` (unused networks only, does not touch running
  containers) cleared it once; if it recurs, prefer `docker run` directly (no network creation)
  over `docker compose up` for anything beyond `config` rendering.
- `spawnSync` in the test file needs `{ encoding: "utf8" }` or `.stdout` is a Buffer, not a string
  — already fixed for the two spots that read `.stdout`, but double check anywhere else you add.
- The compose YAML uses `$$` for every literal `$` inside the `caddy-init` shell command block —
  that's compose's own escape, required so compose doesn't try to interpolate `$JARVIS_TLS_HOST`
  itself before the container ever sees it. Already correct in the committed file — don't undo it.
