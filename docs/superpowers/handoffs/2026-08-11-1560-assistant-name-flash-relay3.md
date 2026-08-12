# Continuation — #1560 assistant-name loading flash (relay3 → relay4)

Compaction checkpoint (context ~70%), not a real handoff boundary. Same worktree/branch. Predecessor
doc (superseded): `docs/superpowers/handoffs/2026-08-11-1560-assistant-name-flash-relay2.md`.

## Status: PR open, feature done. Only remaining work is DB cleanup, and it's BLOCKED.

- **PR**: https://github.com/motioneso/moss/pull/1567 (draft). Gate green (VF_EXIT=0, isolated DB
  `jarvis_gate_1560_assistant_name_flash`). format/lint/typecheck green pre- and post-rebase, HEAD
  `0b6111b1d`. Live-path proof posted as a PR comment
  (https://github.com/motioneso/moss/pull/1567#issuecomment-5250417255) — do not redo.
- **Dev instance already torn down** (API :3097 pid 484729, web :5196 pid 487891 — both killed,
  confirmed dead, ports free). Do not restart it for this cleanup task; not needed.
- **Coordinator**: re-resolve fresh via `herdr agent list` — was `coord-relay2` (codex, session
  `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`) at time of writing, do not trust that name/session as
  current.

## Cleanup task from Coordinator (in progress)

Coordinator asked for exact-scope cleanup of two UAT seed artifacts before the worktree can be
reaped:

1. **DONE**: `app.briefing_definitions` row `d1372db6-d1dc-4f8c-8042-0b5fd8b87fc6`
   (owner_user_id `6dc52034-a0ee-4944-9bfc-ef477af4370b`) deleted via
   `docker exec jarv1s-postgres psql -U postgres -d jarv1s -c "DELETE FROM app.briefing_definitions
   WHERE id = '...' AND owner_user_id = '...'"` → `DELETE 1`. Verified
   `SELECT count(*) FROM app.briefing_definitions WHERE id = '...'` → `0`. Reported to Coordinator.
2. **BLOCKED**: ben@ben.com's `assistantName` persona field was set to `"Nova"` (via
   `PUT /api/me/persona`) across this lane's chain for the live-path proof. **No session in the
   chain recorded the pre-UAT value before overwriting it**, and `persona.bundle` has no
   history/audit table (see `packages/settings/src/persona-routes.ts`,
   `PERSONA_PREFERENCE_KEY = "persona.bundle"`) — it is genuinely unrecoverable from the DB.
   Per Coordinator's own instruction ("stop and ask if that value is unknown"), **I stopped and
   asked** — sent via `herdr agent prompt coord-relay2 "..."` (full text of the ask is in that
   pane's history; summary: DELETE done+verified, persona restore blocked, need either the real
   pre-UAT value or explicit approval for a specific replacement, e.g. clearing to `""` so
   `useAssistantName` falls back to resolved `"Moss"`). **No reply received yet as of this
   checkpoint.**
   - **Do not guess or restore to any value** (not `""`, not `"Moss"`, not anything) without an
     explicit answer from Coordinator/Ben — that was the whole point of stopping to ask.
   - Current DB state right now: `assistantName = "Nova"` for ben@ben.com. Confirm this is still
     true before acting (`GET /api/me/persona` with a fresh login, or a scoped DB read) — do not
     assume it hasn't changed if another session touched it.

## Next steps, in order

1. Re-resolve Coordinator fresh (`herdr agent list`), check for a reply (read the pane, don't
   resend the question — it may be sitting answered in scrollback).
2. If Coordinator/Ben supplied the real value (or explicit approval for a replacement): apply it
   via `PUT /api/me/persona` (or scoped SQL `UPDATE` on the same preference row if API access isn't
   convenient — same care as the DELETE above, scope by owner and preference key, verify after).
3. Report the exact restore evidence (before/after value, verification query/response) back to
   Coordinator.
4. Confirm worktree is reapable (it already is on the code side — nothing to commit; this doc
   itself is docs-only and should be committed by explicit path, same as prior relay docs).
5. **Do not** touch any other shared-dev data, board/milestone/merge state, or re-run the gate —
   none of that is needed again for this lane.

## Reference

- Issue #1560, repo `motioneso/moss` (remote `origin` still points at the old `Jarv1s.git` URL and
  auto-redirects — that's fine, don't "fix" it).
- Plan: `docs/superpowers/plans/2026-08-10-1560-assistant-name-flash.md`.
- Full prior state (now historical, PR/proof/gate steps already done — don't redo):
  `docs/superpowers/handoffs/2026-08-11-1560-assistant-name-flash-relay2.md`.
- This worktree's registered herdr agent name at time of writing: `issue-1560-name-flash4`
  (session `b2a0f924-3f1e-4848-8ded-acdae4fd3f34`). **Re-resolve fresh.**
