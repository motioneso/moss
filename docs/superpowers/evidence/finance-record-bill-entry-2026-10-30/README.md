# Reviewed bill-entry UI evidence

Original, unedited Chromium captures from the passing full installed Finance run at clean
a6a17c7b, receipt 220429-zIHHi9. Fingerprint:
1ec108b81a571ac1c9479bb9677fc171f4fc2d7c8375f930dc1348a269ecb50e.
All 223 cases passed, including all 23 native flows. These are synthetic financial records;
no real bank, credential, financial instruction or production data was used.

- [Phone preview, dark](finance-bill-entry-preview-dark-320.png): actual expense 100.99 USD,
  expected 100.01 USD, current cash 1,000.00 and reviewed resulting cash 899.01.
- [Duplicate blocked, desktop light](finance-bill-entry-duplicate-light-1440.png): the warning
  leads the facts, current balance remains visible and no hypothetical changed balance is shown.
  An existing posted expense remains; another record cannot be confirmed here.
- [Stale review, phone dark](finance-bill-entry-stale-dark-320.png): the recovery message is above
  the captured figures and fixed footer, rather than hidden below the scroll area. Save/Edit
  remain disabled until the user closes and checks saved records.
- [Mandatory host decision, phone](finance-bill-entry-host-confirm.png): the confirmed entry is
  bound to the host decision. The test checks unchanged money before approval and after Cancel.
- [Saved and reloaded](finance-bill-entry-saved.png): posted bill actuals persist. The complete
  fixture also records an independent 1.23 USD expense and a freshly reviewed 50.00 USD bill;
  the final account balance is 847.78 USD with exactly three entries.

The UI, host/API, worker, SQL and owner RLS are real installed code. Provider/credential ports in
the shared fixture are synthetic stand-ins; actual bank/provider HTTP acceptance is unrun.
The native test uses a real independent SQL ledger change for the stale case, not a mocked
rejection. Financial and metadata assertions remain intact after the explicit read-backoff fix.

[Spec and acceptance boundaries](../../specs/2026-10-30-finance-record-bill-entry.md).
[Exact verification and next action](../../plans/2026-10-30-finance-record-bill-entry-checkpoint.md).
