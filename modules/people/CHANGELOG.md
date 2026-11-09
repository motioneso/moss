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
The fifty-reference request fails with the host's default five-second deadline on the test
machine and leaves a partial batch queued. Functional replay passes with an explicit
thirty-second budget; that is not a measured minimum or shipping-budget qualification.
Do not expose this route through the shipping application until its call budget or enqueue
performance is qualified. Failed sends can also leave unsent command records; retention
and quotas remain unfinished.
