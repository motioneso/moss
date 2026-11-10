# Rust server and app, slice 19 report (checkpoint)

## Built

- Manifest fuel request: `fuelLimit` (1..=2,000,000,000) in `moss.module.json`. The host clamps it between its base fuel and a host-wide `fuel_ceiling` (server default 250M). Invalid values fail manifest validation.
- People diagnostic re-run: 60M fuel fails the 1,005-contact paging cases, 200M passes all 29. People now requests 200M.
- Server composition: `moss-shell --modules modules.json` assembles the People notes-folder and suggestion-preference ports with a per-account base root (`notes_base`).
- Live proof on the real server over HTTPS (`pnpm test:rust-people-server`): People installed through the canonical installer, 401 without sign-in, create writes a note file in the account folder, list returns it, notes settings readable and writable.

## Gates

- `cargo test --test boundaries` (16 tests, includes fuel clamp).
- `pnpm test:rust-people-large`, `pnpm test:rust-people-server` (ignored-test gates, need the People component and package env vars).

## Not built (slice 19 items 1-4)

- Automatic bootstrap and installer join beyond the manual modules.json step.
- Quiet-hours deferral, notification metadata/links/dedup, reminder producers, module AI wiring.
- Independent notification process, saved-server activation routing, shared-client coordination.
- Windows supervisor assembly and Stop.
- Slice 18 item 4 Linux-provable parts.

## Not proven

- Second account over HTTP (setup allows one owner), native UI, second physical device, note-folder indexing, new gates in the full gate (cold Wasm compile ~20s in debug; not yet judged reliable).
