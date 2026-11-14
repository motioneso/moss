# Ring phone-to-ring leg: time it, then speed it up (#3856)

Spec: `docs/superpowers/specs/2026-10-29-ring-latency-phase1.md`. Server side is #3854.

## Seams checked

- Press end is detected in `RingConnection.listen` (`released` set by `HoldWatcher` via `note`).
- Connect sequence is the `RingConnection` constructor: connect, MTU 247, discover, subscribe, auth.
- One cycle is `DeliveryService.run` -> `retrieve` (inventory, sidecar, audio) -> `deliver` (freeze, upload).
- `RingConnection` never calls `requestConnectionPriority` or `setPreferredPhy`; every write is `WRITE_TYPE_DEFAULT`.
- Host tests compile only listed classes (`test.sh`), so the timing helper must not touch Android classes unguarded.

## Decisions

1. Timing helper `RingTiming` (new): `begin()` stamps the origin, `mark(label)` logs `RingTiming <label> +<ms>` under tag `RingTiming`. Labels only; no transcripts, tokens, ids or addresses. Origin is the moment the press end is heard, or cycle start when the cycle was not press-triggered.
2. Marks: press_end_heard, connect_start, connect_done, services_done, listing_done, sidecar_fetched, audio_fetched, upload_start, upload_done.
3. Build and install the timing build with `adb install -r` (never uninstall, never clear data). Ben does three hold presses; read the numbers before choosing fixes.
4. Fixes, one at a time, ordered by measured gain, each with a failing test first where host-testable:
   - request high connection priority after connect;
   - fewer round trips (write without response where the protocol allows, batched frames);
   - find why the open link is lost, and keep or restore it without a slow fallback.
5. Unchanged: delivery enable, hold-to-talk opt-in, cleanup choices, Bluetooth permission handoff, exactly-once delivery. A faster path never delivers a partial recording or a duplicate.

## Verification

- `apps/vocci-delivery/test.sh` exit 0.
- `pnpm verify:static` unpiped, exit 0.
- Real-ring RingTiming numbers before and after, on the PR.

## Kill gate

If the first press numbers show the cost is not on the phone-to-ring leg, stop and report to the coordinator.
