# Rust server and app slice 11 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A. Task JS-143 / Card 550.

## Built

This checkpoint starts the independent notification work before more Windows supervisor work.
It changes connected desktop delivery only; it does not implement a background notification
process or the server reminder scheduler.

The desktop poller now stores recent event IDs and pending batches in persistent local
storage, separately for each signed-in account and notification kind. First visits to an
account establish a quiet baseline. Later visits resume pending delivery and notice new items
in the current server response. Viewing the page in the foreground consumes its pending batch
without a banner. These receipts do not mark notification bell items read.

A batch is persisted before sending its opaque document token to the native app. The app answers
that token only after its native notification function reports success, or when desktop
notifications are disabled. Linux and Windows check desktop API acceptance. macOS only submits
to its legacy notification center: it cannot detect OS permission denial, which may silently lose
a banner. Failed native delivery and rate limiting leave the batch pending, with retry delays
growing from five seconds to one minute. A slow Linux desktop service can still block the event
thread for up to a second per kind on an attempt; asynchronous delivery remains unbuilt.
Document and account changes invalidate old in-flight acknowledgements. Banners remain generic;
only event identities and pending state are stored, with no chat or reminder text.

Delivery is at least once: a crash or storage failure after native acceptance but before saving
the receipt may repeat a banner. Native API acceptance does not prove display or that a person
read it. Unavailable or corrupt receipt storage pauses delivery instead of resetting history and
producing an alert flood. Recent history is bounded to a thousand IDs per kind; notifications that
leave the server's current result are no longer retried. Linux and Windows use each saved server's
existing profile folder. macOS uses the shared default WebKit store, so receipts are separated by
server address and account; two saved entries at the same address share history. Per-saved-server
macOS profile isolation remains unbuilt. There is no central receipt database or saved-server
click routing yet.

Moss's desktop app map describes these behaviors and limits. No dependency was added. Workshop
and Food remain unported.

## Verification boundary

The receipt tests reproduce lost delivery against the original poller: a second poll does not
retry an unaccepted new notice. With the fix the same test passes. Additional tests cover receipt
reload, account/profile separation, late acknowledgements, sign-out, foreground suppression,
storage failures, corrupt history, bounded chat history, still-unread IDs at the history cap and
retry backoff. These are protocol tests with a test
IPC receiver, not live native notification proof. The checkpoint PR and proof artifact record the
actual native build/static-check outcomes and any live-path limits from this run.

## Left to full section 13 parity

1. A separately managed notification process after disconnect/quit, saved-server activation
   routing, and the real server/module-worker reminder scheduler. The current receipts are
   profile-local browser storage, not server-side acknowledgements. Durable native delivery and
   post-quit notification qualification remain outstanding.
2. Linux runtime shared-library/OpenSSL/certificate closure and uninstall that preserves user
   instances. Signing and updates remain Phase 7 work.
3. Real second-device or separate-network-namespace HTTPS app proof: remote add, certificate
   comparison, sign-in and Today. Same-host clients do not qualify.
4. Assemble the Windows supervisor with authenticated runner handshake, startup locks, process
   identity/recovery, initdb password/log I/O, state deletion, orderly PostgreSQL shutdown and
   Stop transport. Qualify bundled Windows PostgreSQL under a standard account, including
   interrupted initialization, multiple instances, crashes and Stop/start races, before enabling
   Windows app creation or Stop.
5. Native macOS/Windows app and certificate runtime qualification; OS public-certificate trust.
   `rustls-platform-verifier` remains unapproved and was not added.

Section 13 is incomplete. This is a connected-notification checkpoint, not the full background
notification or cross-device acceptance release.
