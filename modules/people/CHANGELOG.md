# People & Context

## 0.1.0

Rust component and shared-frame People Settings checkpoint. Complete installed parity and physical-device qualification remain open.

Reuse decoded database rows and move list rows into response envelopes. A complete
100-person response matches the legacy handler within the default Wasm budget.
Consume response fields and use explicit wire names instead of copying values and
rebuilding each key. Complete 100-person and 100-link responses now have ordinary-gate
regressions. The expanded diagnostic now exhausts fuel at 150 people during response teardown;
larger reads remain unqualified. Intermediate probes narrow the known failure
boundary without changing runtime code or host budgets.

Preserve every canonical accent when sorting People folders, including multiple accents
on one letter, before comparing case. Comparisons for selected letter families and the installed
folder replay cover this correction; complete locale collation remains unqualified.

Reject forbidden JSON prototype members before schema coercion or host calls, matching
the legacy parser response even inside unknown fields and note-only lists. Ordinary
constructor/prototype fields and string values retain their existing behavior.

Visit nested People notes in the legacy depth-first listing order. Refresh replay fixtures now
include valid nested canonical notes, missing IDs and duplicate IDs instead of silently ignoring
notes without a status field. Existing scan limits and failure refusals remain in place.

Read the host clock once per indexing batch, anchoring its fifteen-minute delay at batch
start while preserving separate command IDs, queue sends and retry timing. This removes
forty-nine clock round trips from the maximum batch; the call deadline remains unchanged.

Compare canonically equivalent Unicode folder names equally, as the legacy folder browser
does. Comparison uses NFC keys; the names and paths returned to callers stay unchanged.
This narrows directory-ordering differences without claiming complete locale collation.

Keep the legacy decimal spelling when a numeric contact value is converted to text, including rounding ties.
The People component parses incoming JSON numbers with correct binary64 rounding before
converting contact values to text. The module host now explicitly enables the same parser
feature in normal builds. An independent downstream regression exercises raw numeric bodies
through installed host dispatch without the native People test dependency. Listener and
installed application qualification remain open.

Retain legacy note-only PATCH list handling and compare configured-folder HTTP edits,
canonical note bytes and all People tables against the existing implementation.

Restore manual index refresh with the legacy batch validation, fifteen-minute delay and
standard-queue repeat behavior. Compare real legacy and Rust queues in the route oracle.
The installed route replay now requires the normal five-second host budget for all fifty
references. Delayed sends reuse one producer connection within an invocation while keeping
separate actor-scoped transactions. A later invocation connects afresh, including after an
idle disconnect. Failed sends are not automatically repeated. The report records measured results rather
than a guarantee for every machine. The shipping listener and real UI remain unqualified.
Failed sends can still leave unsent command records; retention and quotas remain unfinished.
