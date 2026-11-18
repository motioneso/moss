# Rust server/app slice 14: runtime launch routing checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-150 / Card 560. Category: N/A.

Continue slice 13 inside the first Linux runtime item. Stop at a small reviewed checkpoint;
do not advance to reminders or Windows before the native Linux runtime is qualified.

1. Centralize selection of the staged `moss-run` launcher for app-started database lifecycle
   commands and local servers. Keep direct program launch for unstaged development installs.
   A stage with runtime metadata must fail if its launcher is missing, rather than silently
   selecting host libraries.
2. Route certificate generation through bundled OpenSSL during provisioning, without mutating
   the app process's environment. Reuse the network crate's canonical certificate creation.
3. Route Linux start-at-login through the staged launcher. Extend staging to collect the app's
   linked ELF dependencies and allow the launcher to start the app. Explicitly retain the
   native WebKit helper/resource and clean-machine qualification gap; linked libraries alone
   do not establish a complete native desktop runtime.
4. Exercise command routing, autostart arguments and existing packaging boundaries. Run the
   relevant Rust and project checks with task-owned Rust homes and targets; record real
   executable results and any live-proof limits in a recipe artifact.
5. Commit a report listing what remains, obtain read-only Claude review, push a checkpoint PR
   and submit Ready for playtest. No full native installation or section 13 parity claim.

No new dependency or rustls-platform-verifier. Workshop and Food remain unported. Native Linux
resources/clean-machine UI, live This computer creation, reminder scheduling, durable receipts,
notification delivery after app quit, saved-server activation and Windows assembly remain open.
