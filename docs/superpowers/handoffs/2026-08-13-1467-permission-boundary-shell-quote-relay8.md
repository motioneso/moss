# Relay 8 — #1467 permission-boundary-shell-quote

**Status:** root cause of the live-path proof failure found and fixed this relay (commit
`efbfdbb61`, pushed). Re-proof not yet run. PR #1610 has the full root-cause writeup as a comment —
read that first, this doc is just the pointer + next steps.

## What changed (relay7)

`scripts/start-jarv1s.ts`'s `CLI_ENV_KEYS` allowlist for the `cli-runner` child process was missing
`JARVIS_NOTES_ROOTS`/`MOSS_NOTES_ROOTS`. cli-runner is the sole process building the live
permission-hook command line in every containerized deploy, so the shipped #1467 fix
(`vaultRootsEnvEntry()` in `claude-permission-hook.ts`) never received a non-empty value there —
correct in isolation, inert in the real deploy topology. Fixed by adding both keys to the allowlist.
Full evidence chain (docker exec/proc inspection, source reads) is in the PR #1610 comment posted
2026-08-13 and in agentmemory (`memory_recall` query "1467 cli-runner CLI_ENV_KEYS").

## Next steps

1. A UAT stack is still running from BEFORE the fix (project `uat-2001912_5c6086d0`, container id
   `c8e746be4e38a...`, baseURL `http://127.0.0.1:20000`) — state at
   `<scratchpad>/uat-1467-state.json` (session-specific path, re-derive scratchpad root if that
   file's gone; it was written under this branch's session dir). It must be torn down and a fresh
   stack built from the new commit — no bind-mount, the image needs an actual rebuild to pick up
   `efbfdbb61`.
2. Rebuild the `jarv1s` image, provision a fresh UAT stack with `MOSS_NOTES_ROOTS` injected (driver
   mechanism: untracked files `tests/uat/.scratch-1467-provision.ts` +
   `tests/uat/specs/.scratch-1467-proof.uat.spec.ts` if still present in this worktree — never
   `git add` them; recreate from the PR #1610 comment / this handoff's predecessor
   (`...relay7.md`, git history) if they're gone).
3. Re-run the proof spec. Assert: reply contains `PROOF_MARKER`, turn completes well under 150s, no
   `denied`/`action_request` entries in the assistant message's `activity`. Bounded DOM/network/log
   evidence only — **no screenshots** (banned, `2852a12c3`/`6ecdc2a66`).
4. Post the final pass/fail as a `gh pr comment` on #1610 (append to the existing root-cause
   comment's thread, don't duplicate the root-cause explanation).
5. Teardown: normal `assertNoLeakedResources()` path PLUS a manual
   `docker ps -a --filter name=^moss` check — `infra/docker-compose.prod.yml`'s fixed
   `container_name: moss` won't be caught by the project-name-based leak check.
6. If proof passes: full gate via `verify-gate` skill (isolated gate DB) → adversarial cross-model
   QA (AGY, not gemini-cli, not Fable) → Ben's explicit merge sign-off → on merge, comment #1467 +
   update project board 2.
7. If proof still fails: do not iterate blind — stop, update the PR comment with the new failure
   mode, and treat it as a fresh root-cause investigation, not a retry loop.

## Traps (carried over)

- Shared checkout: explicit-path commits only, `git show --name-only HEAD` after each.
- `Moss`/prod container on :1533 — never touch.
- No agent named "Coordinator" exists per `ListAgents` as of this relay — PR comment is the
  reporting channel, not a direct message.
