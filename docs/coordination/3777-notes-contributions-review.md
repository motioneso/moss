# Notes contributions review rulings — #3777

Scope: task 2 of the [reversible-filing plan](../superpowers/plans/2026-10-27-meetings-reversible-filing.md).
The source checkout remains `~/Jarv1s/.claude/worktrees/meetings-build`.

| Finding | Resolution and evidence |
| --- | --- |
| Export payloads had loose object types. | Named `ManagedNote*Export` contracts describe destination, lifecycle, block, proposal and operation payloads. The owning collector uses those types; Settings download and archive assertions cover populated metadata for separate owners. |
| Rechecking a reservation's whole-file revision rejected later unrelated edits and could strand a partially committed move. | Validate the reviewed file/binding when reserving. Later publication reconciles the durable exact source block while retaining unrelated content; Vault still compares the current attempt's bytes. Regression cases cover edits after reservation, target edits after the remove leg commits, and retry after exact source-block repair. |
| Permissive UTF-8 decoding could silently replace malformed original bytes before a mutable-text transform. | Vault decodes original bytes strictly. The regression verifies rejection before invoking the transform and unchanged bytes on disk. |
| Strict decoding stripped valid leading UTF-8 byte-order marks. | Preserve the BOM while rejecting malformed UTF-8. Integrated regressions exercise exact mutation bytes and guarded indexing of a BOM-prefixed managed note. |
| Helper-only indexing tests did not prove production wiring. | Host composition injects the public snapshot port into linked Notes workers, private sweep/nudge workers and the CLI. Registered-worker tests cover oversized-note continuation and one-connection private ingestion. |

Independent Standards review of the integrated task-2 changes found no blockers. Integrated Spec
review caught the BOM decoding issue above; acceptance requires the corrected regression gate.
Scratch controls reproduced the three recovery failures with the old post-reservation revision
check restored; permissive UTF-8 decoding also failed its regression. These controls are development
evidence. The product PR must separately record the integrated full gate, CI and real-model UI proof.

Memory fact lineage, deletion composition, durable Main notices, assembled recording filing and its
controls remain tasks 3–6. Audio and Calendar remain the later phase. This slice does not expose
recording-filing controls or claim that those deferred behaviors have shipped.
