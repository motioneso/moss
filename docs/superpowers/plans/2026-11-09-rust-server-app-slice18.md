# Rust server/app slice 18 checkpoint plan

Part of https://github.com/motioneso/moss/issues/4027. JS-170 / Card 566. Category: N/A.

1. Assemble the existing extended module application in the HTTPS server through an explicit,
   private host configuration. Reuse its catalog, lifecycle, actor boundary and worker entry
   point. Keep blocking Wasmtime and host runtimes off Tokio request threads; own and stop the
   worker with the server. Existing installs without module configuration keep working.
2. Connect extended module notification posts to the server notification feed inside the
   invocation transaction, retaining authorization, actor ownership and rollback on failure.
3. Exercise the assembled boundary and notification transactions on disposable migrated data;
   run scoped Rust and repository static checks, commit, obtain independent review, publish
   actual proof and open a checkpoint PR.

Stop at this assembly checkpoint if the context budget cannot also qualify real reminder
producers and installed native delivery. Do not claim those paths from synthetic guest or HTTP
fixtures. Automatic module bootstrap/install and AI wiring remain separate from this explicit
assembly; configuration requires an existing approved module catalog and its canonical schema.
Standalone background notifications, Windows assembly, native Mac/Windows, public certificate
trust and physical second-device proof remain left. No new third-party dependencies.
