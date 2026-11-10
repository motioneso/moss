# Rust server and app, slice 20 report (checkpoint)

## Built

- Item 1, automatic bootstrap. App-created instances get a private `modules.json` at setup. The server uses it without a flag, retries in the background and serves modules as soon as the first one is installed, with no restart. `moss-shell install-module` creates missing module tables (idempotent), records the instance owner and installs signed modules from a registry folder or address. Without `--approve`, a module asking for new permissions is refused.
- `moss-db credentials --module-host` returns the migration-owner and worker database addresses. The server's own credentials file keeps its four fields.
- Module routes answer 503 until a module host is running.

## Live proof

`pnpm test:rust-module-bootstrap` (through scripts/run-gate.sh, disposable database): a fresh instance with no module tables and no owner. The real HTTPS server starts with only `--instance`. The owner signs up. Module routes answer 503. `install-module` installs the provider and People. Without a restart the server then returns 200 for the list, saves notes settings, creates a person whose note lands in the account folder, and lists it. Passed in 87 s.

Unit checks: the installer's argument parsing and bootstrap markers; shell and app suites green (31 tests).

## Not built

- Item 2: saved-server activation routing and shared-client coordination (native app work).
- Item 3: independent notification process, quiet-hours deferral, notification links and dedup.
- Item 4: Windows supervisor assembly and Stop.
- Item 5: module AI wiring (still fails closed).
- App-side call of `install-module` (no screen yet runs the installer; only the command exists).

## Not proven

- Second physical device, native UI, installing from a remote registry over the network, an app-created instance end to end (the gate builds the same files by hand), Windows and macOS.
