# UX #995 — Connected Accounts Cleanup: UAT Evidence

Manual real-dev-instance UAT (per the #1000 UAT harness rule for UI/UX features), run against
live API (`:3901`) + web (`:5175`) dev servers and the shared dev Postgres, on PR #1063
(HEAD `e5d18ad0`). Verified checklist:

- Admin approve of a pending signup succeeds.
- Picker copy shows Google / Email (IMAP) / GitHub disabled "Coming soon · #1061", with no
  Apple/other-OAuth option.
- IMAP provider select renders with Fastmail visible.
- Test connection and Connect stay disabled until both fields are filled, then become enabled.
- Bogus IMAP credentials produce a clean inline error without a crash or blank screen.
- The IMAP form and picker work at a 390×844 viewport.

**Reconnect-path coverage:** `AccountRow.onReconnect` and
`ServicePicker.onImap` both route to the identical `<ImapConnect onBack={...} />` call site with
no `initialProvider` ever passed
(`apps/web/src/settings/settings-personal-data-panes.tsx`) — confirmed by direct read. The
existing mocked `tests/e2e/connect-imap.spec.ts:57` is relied on as evidence for the Reconnect
routing click itself; no throwaway connector-account row was seeded for it.

Ran via a throwaway local script (`tests/uat-scratch/uat-manual.mjs`, Playwright-driven), deleted
after this evidence was captured — it was never intended to be committed.
