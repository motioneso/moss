# Rust server/app slice 14: runtime launch routing checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-150 / Card 560. Category: N/A.

## What this checkpoint provides

The Linux app now selects the staged `moss-run` launcher for local server startup and all
database lifecycle commands, including status, credentials and Stop. Provisioning passes a
selected OpenSSL command to the network crate's existing certificate maker, rather than changing
the app's process environment or duplicating certificate policy. An install with a runtime folder
and no launcher fails instead of silently launching programs directly. Unstaged development
installs still use direct programs and the installed OpenSSL.

Linux Start Moss at login now registers `moss-run moss-app` for those runtime installs, retaining
the selected install and data folders and the existing desktop-entry escaping. Missing launchers
produce a settings error. Staging also includes the app's linked ELF libraries and permits the
launcher to start the app. Its closure metadata explicitly excludes native WebKit helpers and
desktop resources. This is still an unsigned build-platform ABI checkpoint, not a complete native
app runtime or general Linux installer.

The app map describes these launch paths and retains the qualification limits. No new screen,
setting or third-party dependency was added.

## Real proof and checks

The isolated `test:rust-app-runtime-routing` gate passed using task-owned Rust homes and target
directories. With a freshly assembled stage and no instance folders, production app functions:

- Created two independent instances using bundled OpenSSL and canonical Phase 1 PostgreSQL/schema.
- Started each real server sequentially on a claimed task port and verified its HTTPS hello.
- Checked the server's real executable identity and that its mapped libc came from the stage.
- Stopped each server and database and removed the test data.

The app and server were rebuilt from this worktree. Unchanged WebAssembly assets and the existing
canonical PostgreSQL bundle/supervisor were reused as assembly inputs. This proof runs on the
build host, not in a clean desktop root. It calls production app functions, not the This computer
screen, and is not the requested UI or second-device proof.

All eleven packaging tests pass, including a real compiled launcher probe that checks app/server/
supervisor argument boundaries and selected runtime environment. That same new test was observed
failing against the previous launcher with exit status two, then passing with this change.
The app suite passes all twenty-seven active tests serially, with two explicit live tests ignored
by default. The initial parallel run failed the existing immediate lock-reacquisition assertion;
the serial run passed. No lock algorithm was changed. Autostart selection and desktop escaping
are unit checked, not qualified through a fresh desktop login.

Full foundation tests, CI and browser end-to-end tests are not claimed. Proof artifacts and logs
stay outside the public repository.

## Left unbuilt, in order

1. Finish native Linux WebKit helper/resource packaging and prove app startup and autostart in
   a clean machine/root. Linked ELF libraries and launch routing alone do not close this item.
2. Exercise creation and start through **This computer** in that assembled native Linux app.
   The function-level lifecycle result above does not close the UI qualification requirement.
3. Server/module-worker reminder scheduling, durable server-side acknowledgements, an independent
   notification process surviving app quit, and saved-server activation routing.
4. Windows supervisor assembly and Stop under a standard account before enabling app creation.
5. Native macOS/Windows app and certificate qualification, operating-system public certificate
   trust, physical second-device LAN/tailnet HTTPS proof, signing, updates and production installers.

No rustls-platform-verifier was added. Workshop and Food remain unported. Full section 13 parity
is incomplete. Continue with native Linux resources and clean-machine qualification, not reminders.
