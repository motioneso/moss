# #3578: adopted-image persistence entry rejected

- **Outcome:** `BLOCKED_BEFORE_LAUNCH` at the required RAM floor. Firefox sandbox and replacement persistence remain **NOT_RUN** on the adopted image.
- **Operator/finish operator:** Codex `/root`, session `01a16981-6c86-7df1-82ab-397cf5db2e90`, actively attended.
- **Branch:** `qualify/moss-computer-persistence`, based on handoff commit `f467eb2c4` and merged checkpoint `65fc78250fbca425b56e9a9bc9cc2325ce17a804` (#3579).
- **Dispatch:** [Full handoff and Start section](../../superpowers/handoffs/2026-10-23-moss-computer-persistence.md), parent handoff PR #3587; task #3578 / parent #3577 remain open.
- **Receipt:** [Sanitised preflight](2026-10-23-persistence-preflight.json). Private receipts/state remain outside the repository in sibling `../moss-computer-persistence-r5/`.

## Entry decision

The handoff's Start section requires stopping on failed entry gates. Fresh read-only entry checks
began at 16:04:40 UTC; closure was recorded at 16:06:27 UTC, within ten minutes. The available-RAM
sample failed the exact 8 GiB floor. Stop this assignment at entry rejection; do not wait or retry
until a sample passes, relax the floor, load the image, or launch a desktop.

| Entry check         | Observed                                 | Required/result                                                    |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Available RAM       | 8,330,731,520 bytes                      | At least 8,589,934,592 bytes; **FAIL**, short by 259,203,072 bytes |
| Root free           | 11,153,100,800 bytes                     | At least 8,589,934,592 bytes; PASS at sample                       |
| Data free           | 1,033,573,777,408 bytes                  | At least 32,212,254,720 bytes; PASS at sample                      |
| Swap used           | 8,589,881,344 bytes                      | Snapshot only; no capacity or stability claim                      |
| Exact adopted image | Docker inspect exited 1, `No such image` | Absent; restore path was not attempted after RAM failure           |
| Moss                | Running, healthy                         | Observed before and at closure                                     |

Required image remains
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
The retained reconstruction archive is present at its expected 1,026,041,856-byte size. Its checksum,
config identity and seven layer digests were **not reverified in this attempt**; no image load,
rebuild, substitute candidate or inspection container was attempted. Archive size alone does not
qualify a restore. Image disappearance and the reported Herdr restart causes remain UNKNOWN.

Initial entry values and the image error are explicitly transcribed from tool outputs into the
private receipt. Original raw command files and a separate exact RAM-sample timestamp were not
retained. Directly captured closure receipts establish the later health/resource-ownership facts;
they do not upgrade the initial transcription into independently captured raw measurements.

## Scope and closure

No launch packet/configuration, synthetic home, guest, gateway, network, port reservation, keys,
browser, watchdog or listener was created. Launch-packet preparation and prelaunch review were
not reached because the earlier entry gate failed. No actual sandbox diagnostics, browser state,
file/profile control or replacement proof ran. The original-image persistence acceptance and
adopted-image recovery-r4 acceptance remain scoped to their own receipts.

Closure commands exited 0: exact fresh label `com.moss.proof=persistence-r5` had no containers or
networks, the reservation list had no entry for this run, and Moss reported `running healthy`.
The earlier r1/r3/r4 home paths and reconstruction archive remained present. No writes to those
retained paths were performed; their contents were not rehashed. No owned runtime existed to stop
or remove. Unrelated existing listeners and reservations were left alone.

No host repair, service restart, prune, DB/foundation command, production or product change.
There was no runnable Firefox failure loop in this attempt: diagnosis stops at entry failure,
without a browser hypothesis, fix or regression claim. No app-map change is required for this
evidence-only result. News/Direct On and guide/manual/MacBook/Internet/owner/session/download/
installer/platform/release gates retain their independent requirements. No automatic merge or issue close.

## Independent review and one next proposal

Independent exact-artifact review is recorded in the [review ledger](2026-10-23-independent-review.md).
Acceptance here means acceptance of the entry rejection evidence, never runtime qualification.

Propose one separately dispatched attempt of the same bounded adopted-image active Firefox sandbox
and actual file/profile replacement proof after fresh RAM/root/data floors pass. If the image is
still absent, verify the retained archive checksum, config and all seven layer digests before one
bounded exact load. Commit a fresh packet with exact run/config/scripts, safe disposable negative
controls, supervision and cleanup; obtain independent readiness review before launch. Preserve
the existing offline guest, container/browser protections and active attendance bounds. This
proposal dispatches no new attempt and authorises no infrastructure investigation or repair.
