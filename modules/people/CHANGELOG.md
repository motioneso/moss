# People & Context

## 0.1.0

Rust component and shared-frame People Settings checkpoint. Complete installed parity and physical-device qualification remain open.

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
