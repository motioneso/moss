# Relay 4: UX #995 Connected Accounts Cleanup

Worktree: `~/Jarv1s/.claude/worktrees/ux-995-connected-accounts-cleanup`
Branch: `ux/995-connected-accounts-cleanup`
Coordinator label: `UX Coordinator` (resolve fresh by label via `herdr pane list`, never a raw
pane id — they reflow).

Prior relay: `docs/superpowers/handoffs/2026-07-14-ux-995-connected-accounts-cleanup-relay-3.md`
(superseded — its two env gotchas are fixed and its approval-gate options are resolved below).

All code/tests/gate work for #995 is DONE and committed (HEAD `b5dd2e1a`, clean except auto
`.claude/context-meter.log`). Only remaining item is finishing **manual real-dev-instance UAT**,
then **coordinated-wrap-up**. Do not re-plan or redo the gate/secret-egress audit — see relay-2/3.

## Servers already running — reuse, don't restart blind

- API on `:3901`, pid `1666760` (confirm still listening: `ss -ltnp | grep 3901` before reuse)
- Web on `:5175`, pid `1669697` (confirm still listening: `ss -ltnp | grep 5175`)
- Both confirmed live as of this relay. If either is dead, restart with the recipe in relay-3
  (`JARVIS_AUTH_TRUSTED_ORIGINS` must equal the **API port**, not the web port).

## Approval-gate: RESOLVED — use these real creds

Shared dev Postgres already has a bootstrap owner. Use the real admin-approve UI (option (a) from
relay-3, most faithful):

- Admin: `uat-admin@jarv1s.local` / `uat-admin-password-1025` (real seed account, already an
  active bootstrap owner — see `tests/uat/seed/admin.ts`)
- Pending test user already signed up and waiting for approval: `uat-995-mrlmgngy@example.test` /
  `correct-horse-battery-staple-995`

## Reconnect-path coverage: DECIDED

`AccountRow.onReconnect` and `ServicePicker.onImap` both route to the **identical**
`<ImapConnect onBack={...} />` call site with no `initialProvider` ever passed
(`apps/web/src/settings/settings-personal-data-panes.tsx`) — confirmed by direct read. So the
manual picker→IMAP pass below already exercises the same render path Reconnect would produce.
**Decision: rely on the existing mocked `tests/e2e/connect-imap.spec.ts:57` as evidence for the
Reconnect routing click itself** — do not seed a throwaway connector-account row, not worth the
token spend. State this explicitly in the wrap-up report.

## Settings routing gotcha (already fixed in the script below)

Settings nav is a single `/settings` route driven by `?section=<id>` **query param**, not path
segments (`apps/web/src/settings/settings-page.tsx`). Use `?section=people` (admin People pane)
and `?section=connected` (personal Connected-accounts pane). Two earlier path-segment bugs
(`/settings/admin`, `/settings/connected`) are already fixed in the script.

## Next action — pick up here

`tests/uat-scratch/uat-manual.mjs` (untracked, **do not commit** — throwaway UAT tooling) is
written and the navigation bugs are fixed, but **the fix has not yet been verified by running it**.

1. Confirm servers still live (commands above); restart if needed.
2. Run it: `node tests/uat-scratch/uat-manual.mjs` from the worktree root.
3. Read stdout (`UAT_OK` / `UAT_FAILED`) plus
   `/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-ux-995-connected-accounts-cleanup/*/scratchpad/shots/log.txt`
   and the assertion artifacts in that same evidence dir.
4. Confirm the full checklist passes: admin approve succeeds, picker copy (Google / Email (IMAP) /
   GitHub disabled "Coming soon · #1061", no Apple/other-OAuth), IMAP provider select renders,
   Test/Connect disabled until both fields filled, bogus-cred "Test connection" shows a clean
   error (no crash/blank), narrow-viewport (390×844) pass for both picker and IMAP form.
5. Fix forward if anything in the script itself is still broken (it's throwaway tooling, edit
   freely) — the product code under test is out of scope for edits unless UAT surfaces a real bug,
   in which case escalate to `UX Coordinator` before touching product code (this is a security-tier
   spec — connector credential UI).
6. Then run `coordinated-wrap-up`: clean tree (delete/leave `tests/uat-scratch/` untracked, never
   commit it; the untracked `relay-2.md` copy in this dir is a harmless predecessor leftover, fine
   to ignore), pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + rebase onto
   `origin/main`, full gate, push, open PR, report PR + HEAD sha + UAT evidence (incl. the
   reconnect-path decision above) to `UX Coordinator` (resolve fresh by label). Do NOT merge, touch
   the board, or close the issue.

## Local TaskList

Tasks #1 (UAT, in_progress) / #2 (reconnect decision — now resolved, just needs restating in the
wrap-up report) / #3 (wrap-up, pending) already exist — reuse, don't recreate.
