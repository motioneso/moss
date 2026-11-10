# Rust server and app, slice 21 report (checkpoint)

Part of https://github.com/motioneso/moss/issues/4027. Card: JS-188.

## Built

Item 1: the app can install modules from the registry.

- Server routes `GET /api/modules`, `POST /api/modules/plan`, `POST /api/modules/install`.
  Each call needs a signed-in instance admin (403 otherwise) and a valid module name.
- The server never holds the superuser database address. Each call runs `moss-shell
install-module` as a child process. The address comes from `moss-db credentials
--module-install` and reaches the child only through its environment for that one run.
- `install-module` gained `--list` and `--plan`. Plan prints the permission list and
  migration count and installs nothing, so the prompt works before any module exists.
- An install without `approve` is refused with 422. A module name that looks like an option
  is refused with 400.
- The app has a Modules screen (nav section "Instance", admins only) with a list, an Install
  button, a permission dialog and status messages.
- Registry settings are read from `<instance>/registry.json`.

## Proven

Gate `pnpm test:rust-install-endpoints`, run through `scripts/run-gate.sh`, passed on a real
HTTPS server and a throwaway database (commit 84839534). It covers: owner sign-up, 401 with
no cookie, list, plan with permissions, unapproved install refused, approved install, option
smuggling refused, and People answering 200 after the install with no restart (503 before).
Unit tests for name validation and argument parsing pass.

## Not proven

- The Modules screen compiles and is built into the web bundle, but it has not been opened in
  a browser. No screenshot exists.
- Registry settings are file-based only. There is no in-app way to set them yet.

## Review

Round 1 (Codex): one major, fixed. Approval now names the reviewed version and the installer
refuses if the registry's latest differs (gate checks a stale version gets 422 and a missing
one gets 400). Three minors left open:

- The list marks a module installed by id, so a newer registry version shows no Install button.
- The screen keeps Install buttons enabled while a request runs, so a slow reply can overwrite
  a newer dialog.
- The gate checks permission group and headline are present, not their exact wording.

## Not built

- Item 2: module AI through the capability router. Design is settled: a database-backed
  configuration store over the AI provider and model tables, credentials opened with the AI
  secret cipher, wrapped in the existing router and HTTP adapters, failing closed when no
  model is set. Modules still fail closed with "not configured".
- Item 3: independent notification process, quiet hours, links, dedup.
- Item 4: saved-server activation routing and shared-client coordination.
- Item 5: Windows supervisor assembly and Stop.

## Notes

- The Vikunja card for JS-188 could not be found by search, so it was not moved or commented.
- Running the gate in a fresh worktree needs `pnpm install --frozen-lockfile` first.
- The People gate inputs need a generated guest, UI and package built into task-owned folders.
