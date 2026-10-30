# Bill-match date-window UI evidence

Original, unedited Chromium screenshots from the installed synthetic Finance application,
inspected at desktop light and 320px dark. A September 30 posted expense is selected for an
October 1 projected bill; the visible candidate window is September 24 through November 7.
The shared scroll-body dialog keeps its footer inside the phone viewport.

- [Phone, dark, 320px](finance-bill-match-dark-320.png)
- [Desktop, light, 1440px](finance-bill-match-light-1440.png)

Images come from development receipt 202017-hMNVbE at fb024467 with nine dirty files,
fingerprint 238e61b80e0dced929341db2841d89b780f0a964ac53ce8065e3e2861a1b77bb.
That run passed both selected installed flows. The subsequent empty-index correction changes
candidate partition reads and the final type annotation changes a unit test; neither changes
the pictured UI. The final clean native run at 170dc61f also passed both selected flows.
Twenty other native tests were intentionally skipped, not established by this narrower gate.

UI, host/API, worker, module SQL and owner RLS are actual installed code. Provider/credential
ports are the shared fixture's synthetic stand-ins. No real account, bank connection, credential,
financial instruction or production data was used. Matching an existing expense creates no
ledger entry. These images are bounded workflow evidence, not universal product parity.

[Verification, limitations and manual continuation](../../plans/2026-10-30-finance-bill-match-checkpoint.md).
[Design and official comparison sources](../../specs/2026-10-28-finance-parity.md).
