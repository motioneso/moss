# Rust server/app slice 17: worker scheduling and desktop receipts checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-164 / Card 565. Category: N/A.

## What this checkpoint changes

The module host's existing worker entry point now advances due Phase 2b schedules before
claiming work. It reuses the durable queue, missed-occurrence coalescing, active module
declarations and existing module/account fences. No scheduler runs in a desktop page. The
schedule-only Wasm regression no longer calls the scheduler on the worker's behalf: it must
execute a due job through `Installer::run_job`, before and after a module upgrade.

The authenticated server can persist desktop notification acceptance for the signed-in
recipient and a client UUID stored in that server's web profile. Polling still returns only
notification identities; it also returns the accepted subset for that client. The app writes
acceptance after the existing native backend reports submission, or notifications are off.
Failed server writes leave the batch pending. Repeated writes are idempotent, and a persisted
server receipt suppresses a restored local pending entry. Acceptance does not mark bell items
read. Other clients are independent, chat acceptance stays local, first visits stay quiet,
and older servers retain local-only acceptance without unsupported POST retries.

The new notification-owned migration is additive and uses recipient RLS, including for admins.
The Phase 1 supervisor already stages that canonical migration folder. No supervisor migration
copy, package or certificate-verifier dependency was added. The network lockfile was refreshed
for its already-declared keystore libc dependency so the certificate proof builds with `--locked`.
Moss's desktop app map describes the new acceptance boundary.

## Proof boundary

This is a partial checkpoint on slice 16's first remaining item. `Installer::run_job` is a host
library entry point; the shipping server still does not assemble the module host and its worker
loop. The host's `notify` port still writes module-local records rather than feeding
`app.notifications`. This checkpoint does not claim end-to-end reminder authoring, scheduling
and arrival in the installed app. The HTTPS proof creates real notification rows in a disposable
database to exercise the actual receipt routes; it does not use a real reminder producer.

The task browser could not start Chrome: it exited with “No usable sandbox”. No sandbox was
disabled. Native app delivery, browser UI and physical second-device HTTPS were not qualified
in this checkpoint. The HTTP fixture uses a minimal index page and cannot prove the shell UI.

## Checks

The schedule regression was observed failing before the worker fix, at “The module worker must
advance schedules and execute the due job itself”. Final gate and static outcomes are recorded
in the task proof artifact and checkpoint PR. All Rust checks use task-owned Cargo, rustup and
target directories; database checks run only through verify-gate.

`rust-spike/shell/tools/receipt-gate.sh` builds the server and certificate helper and runs the
verified-HTTPS receipt proof against disposable migrated data. It covers authenticated writes,
idempotent retry, persistence across a real server restart, independent clients, foreign IDs,
unchanged bell reads, malformed/oversized batches, origin and signed-out refusal, recipient RLS
and receipt cleanup on deletion. Its protection-removal control disables receipt RLS only in
the disposable database and checks that the forbidden write becomes possible, then restores it.
The client logic tests use an explicit simulated backend; they are not native desktop proof.

Whole-workspace `cargo fmt --all --check` includes pre-existing formatting differences in path
dependencies. Changed Rust files are checked separately without formatting unrelated sources.

## Left unbuilt, in order

1. Assemble the server and module worker loop, connect the module notification port to the
   server feed, and port/qualify real reminder producers end to end. Qualify the changed
   acknowledgement path through the installed native app.
2. An independent notification process surviving app quit, with saved-server activation
   routing. Shared-client coordination with that future process is not implemented.
3. Windows supervisor assembly and Stop under an ordinary account before enabling app creation.
4. Normal-desktop pointer links, desktop-login autostart, hardware/composited rendering,
   target-root installation/removal and general clean-machine installation qualification.
5. Native macOS/Windows app and certificate qualification, OS public certificate trust,
   physical second-device LAN/tailnet HTTPS, signing, updates and production installers.

Workshop and Food remain unported. No rustls-platform-verifier was added. This is code-complete
at the library/HTTP checkpoint boundary, with the installed reminder path unverified; full
section 13 parity remains incomplete.
