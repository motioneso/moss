# Finance review evidence

Original installed-app screenshots from the successful owned-details scenario of
full receipt 142921-Z9rN0U (the whole run failed a separate read). Synthetic identities
and financial records only. Implementation 682a8162999f24d92610fa80fc6702766f5a47f4, clean input ef9dfd37eadc.
Selected installed metadata receipt 142715-Ms9Br9 passed its complete selected flow
(1 passed, 20 unrelated skipped), including captured details, unchanged full notes,
all twelve light/dark/Sage and 320/390/768/1440 layouts, modal bounds/focus return,
actual category confirmation and pending-settlement review. Provider and credential
ports are disclosed mocks; SQL, installed reads and host confirmation are real.
This is not live bank acceptance, CI e2e or an entire parity claim.

[Desktop details](finance-transaction-details-light-1440.png)

[Phone details](finance-transaction-details-dark-320.png)

Full Finance receipt 142921-Z9rN0U on the same clean implementation passed 169 backend
and 20 browser flows, including actual shared details. Its one failed manual-register
read received HTTP 400 from the resource-bounded external pattern-validation worker
while the broad unit gate was running. It remains a failed whole run. No pattern
guard, timeout, rate limit or financial assertion is weakened. Serialized full
acceptance still needs its own receipt.

See the [register checkpoint](../../plans/2026-10-30-finance-register-details-checkpoint.md)
and [parity matrix](../../specs/2026-10-28-finance-parity.md) for capability and test limits.
