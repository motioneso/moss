# Manual net-worth history projection at scale

Authorized continuation of Finance parity and trustworthy ledger work. Isolated task branch; commit
and push, no merge/deployment or real financial actions. Synthetic fixtures only. This records the
small delegated design before implementation.

The manual-net-worth SQL currently returns one record per account/day across all owned history.
The platform correctly refuses reads above 5,000 result rows. Long multi-account histories can hit
that limit even though only a bounded report window is visible. Narrowing the visible window does
not remove the lifetime movement needed for carry. Do not raise or bypass platform query row, byte
or execution-time caps, truncate financial history, or substitute today's mutable account balance.

Project the same exact validated daily movements inside account/month records, matching Finance's
existing month-chunk vocabulary. One SQL snapshot first aggregates numeric daily cents and source
validation evidence, then returns ordered month-sized arrays. The store flattens only explicit fields
back into the unchanged daily-movement domain interface. Owner RLS, original calendar dates, signed
integer strings, source-currency/opening validation and absence of names/notes remain unchanged.
No migration, new UI/tool, provider history change, cache or persisted derived balance is needed.
The existing 5 MiB result cap remains an honest limit for extreme histories.

Add a synthetic history above 5,000 distinct movement dates. Observe the old daily projection fail at
the platform row cap, then prove full movement count and the exact pre-window/current balance with
the month projection. Never test by disabling the cap. Retain source-validation, same-ID owner and
negative RLS evidence. Run installed SQL, focused units, type/lint/static and the real installed
manual-only net-worth UI on the new code, with the established phone/desktop and theme coverage.
Update the matrix/checkpoint without claiming arbitrary-sized history or broader investment parity.
