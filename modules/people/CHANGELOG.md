# People & Context

## 0.1.0

Rust component and shared-frame People Settings checkpoint. Complete installed parity and physical-device qualification remain open.

Keep the legacy decimal spelling when a numeric contact value is converted to text, including rounding ties.
Parse JSON contact numbers with correct binary64 rounding before converting them to text.

Retain legacy note-only PATCH list handling and compare configured-folder HTTP edits,
canonical note bytes and all People tables against the existing implementation.

Restore manual index refresh with the legacy batch validation, fifteen-minute delay and
standard-queue repeat behavior. Compare real legacy and Rust queues in the route oracle.
The fifty-reference request fails with the host's default five-second deadline on the test
machine and leaves a partial batch queued. Functional replay passes with an explicit
thirty-second budget; that is not a measured minimum or shipping-budget qualification.
Do not expose this route through the shipping application until its call budget or enqueue
performance is qualified. Failed sends can also leave unsent command records; retention
and quotas remain unfinished.
