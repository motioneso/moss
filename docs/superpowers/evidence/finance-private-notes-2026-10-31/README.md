# Approved note-recovery fixes: original UI evidence

Captured 2026-10-31 from clean source `54c2adbbf1279ae08e312fe3b750d94771f2c9ff`.
Receipt: /tmp/jarv1s-gate/moss_finance-20261031-001150-KUDeIF.log.
Fingerprint: `57884b3d293dd80e72171a7d1744c20134c817f7dfb9525c9c824860d5aedb62`.
Four selected installed flows passed; twenty were excluded. The complete Finance run on this
same source also passed 237 tests/20 files, including all 24 installed-browser flows, receipt
/tmp/jarv1s-gate/moss_finance-20261031-001414-MBYx3C.log.
Node 24.19.0, pnpm 10.6.2, system Chromium, disposable PostgreSQL 17.11.

All financial/auth data is synthetic. UI, host confirmation, API, worker and SQL/RLS are real;
provider/credential ports are inert fixtures. No real provider HTTP was exercised. These are
original byte-for-byte PNG copies, without crop, resizing, recoloring or annotations.

All twelve selected originals were visually inspected. At 320px, conflict and uncertain-save
states show the reason, readable retained text and an accessible recovery action. Recovered
comparison shows current saved text above the draft without clipping the fixed actions.
Loading has enabled close/back controls. Dark focus and selected-text states remain visible.
The test checks desktop/phone overflow, action bounds, keyboard containment, disabled submitted-
write close, and enabled read-only text selection with typing rejected. It holds a real read,
closes/reopens, changes saved SQL state, then releases the old read during a newer confirmation.
The older response cannot replace the new saved version or release the write close protection.

**Strict overall design review remains open in the main conversation.** This is acceptance of
two scoped recovery corrections, not product-wide UX/WCAG or YNAB/Monarch parity certification.
The [previous originals](../finance-private-notes-2026-10-30/README.md) retain before-fix provenance
and broader budget/accounts/reports/bill-entry review states. Token contrast evidence there is
source-role analysis, not a rendered-pixel audit.

| Original                                                                                       | Size       | Exact state                                                                                      | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [finance-private-note-loading-light-1440.png](finance-private-note-loading-light-1440.png)     | 1440 × 900 | Desktop light: initial read pending, with enabled close/back actions.                            | `bb83178c49d5c5edc3b7b0589e9e32b0a8ab7dd92cdb5943eb4de046c4c266cb` |
| [finance-private-note-loading-dark-320.png](finance-private-note-loading-dark-320.png)         | 320 × 900  | Phone dark: pending read can close, fixed actions fit.                                           | `1902ebe1c7322be4c301b81bb5c40f51d57a7e6511aa210addf661817042e0ff` |
| [finance-private-note-edit-sage-1440.png](finance-private-note-edit-sage-1440.png)             | 1440 × 900 | Desktop sage: editable Unicode draft, byte capacity and explicit save.                           | `345ae3df3d38534898a32d6ffd59fc9ea87cd4a8cf4bb4ec6d600ca096a4aa4f` |
| [finance-private-note-edit-dark-1440.png](finance-private-note-edit-dark-1440.png)             | 1440 × 900 | Desktop dark: visible keyboard focus on Save.                                                    | `f3b5cf6978387d656c5ff78dd7964af066579cb070d6e091a788c992b6746f5d` |
| [finance-private-note-edit-dark-320.png](finance-private-note-edit-dark-320.png)               | 320 × 900  | Phone dark: readable wrapping, textarea and fixed actions.                                       | `34ef736bcdc302816b86323f15bff9c540914b6256dd8f7543e302dd798594e1` |
| [finance-private-note-stale-light-1440.png](finance-private-note-stale-light-1440.png)         | 1440 × 900 | Desktop light: actual intervening SQL write; read-only draft remains keyboard-selected.          | `f5accb9af4c9a6750abd69a80140c64d34cfc7b6c03c4dcf19cc732867876d0e` |
| [finance-private-note-stale-dark-320.png](finance-private-note-stale-dark-320.png)             | 320 × 900  | Phone dark: copyable blocked draft, reason and Check saved note action.                          | `262962826e084d3d926b235e407ecfaf7abbcbe89d6cb45c818359a296ac6c19` |
| [finance-private-note-stale-sage-320.png](finance-private-note-stale-sage-320.png)             | 320 × 900  | Phone sage: focused copy selection and recovery action.                                          | `3111f967648e2f34841928c9e60de7caa9e0f759cc822e592b4fe372cbb030c5` |
| [finance-private-note-uncertain-light-1440.png](finance-private-note-uncertain-light-1440.png) | 1440 × 900 | Desktop light: actual approved commit followed by synthetic HTTP 503; no blind retry.            | `528ad4c0ce228554eb47dd0813535a8026774f937a682192cfdf5aee1885ceb8` |
| [finance-private-note-uncertain-light-320.png](finance-private-note-uncertain-light-320.png)   | 320 × 900  | Phone light: preserved copyable draft after uncertain response.                                  | `8b09e17b05678760e804f3db78f9a32480c94639eeb8fd8a62059b46321b9d1e` |
| [finance-private-note-recovered-dark-320.png](finance-private-note-recovered-dark-320.png)     | 320 × 900  | Phone dark: current saved note above retained editable draft; fixed save/back actions.           | `91ff1aa23cc7de3ecb706eec1df268c5a02724ae3713b3ea4682d27eff691fc8` |
| [finance-private-note-recovered-sage-1440.png](finance-private-note-recovered-sage-1440.png)   | 1440 × 900 | Desktop sage: independent saved text and draft are clearly labeled before intentional overwrite. | `023a738e833df63f6ccb42a1e6e1e27cfa71f30c0224efeafa62518a1c821197` |
