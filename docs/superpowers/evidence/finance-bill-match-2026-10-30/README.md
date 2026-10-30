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

## Explicit candidate review and empty state

These original, inspected screenshots are from the passing native refinement receipt
203254-Z9aprb at clean d5215bee, fingerprint
f0a3e1e07b4774e5e6aae9ad31ce67bbbbe35b97d092568107141d5a29563438.
Both selected flows passed; twenty others were intentionally skipped.

- [No candidates, phone dark](finance-bill-match-empty-dark-320.png): a controlled pending
  synthetic expense leaves no posted match. Select and Save are disabled, recovery instructions
  are visible and Cancel stays available inside the phone viewport.
- [Explicit review, desktop light](finance-bill-review-light-1440.png): after fixture restoration,
  the review explains nearest-date / nearest-amount ordering and preserves variable actual
  amounts. The test asserts that nothing is preselected and chooses the expense explicitly.

The temporary fixture flip changes its review version; the test verifies every other field is
restored, then compares the full current ledger response across actual matching. Production UI
is unchanged after c788fb17; d5215bee corrects that fixture assertion. e8a10979 changes only an
array-reversal expression in a pure unit test to match the TypeScript target. Those later inputs
must not be described as the same native gate. No image editing, real bank or production data.
