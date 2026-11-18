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

## Call time limit (JS-307)

Every module call used to get 5 seconds. A real AI model needs 11 to 14 seconds even for a
one-line prompt, so any module that asks a model for something inside one request got
"unavailable".

- A module may now ask for a longer limit with `callLimitMs` in `moss.module.json`
  (1 to 120,000 milliseconds; anything else fails manifest validation).
- The host grants it between the 5 second default and a host ceiling of 30 seconds. A request
  above the ceiling is clamped to 30 seconds. A module that asks for nothing keeps 5 seconds.
- It has the same shape as the compute budget request (`fuelLimit`): the host holds the
  default and the ceiling in its limits, and the manifest only asks.
- The limit covers the whole call, including the host services it uses. The AI service gives
  up at the same moment, so a slow model cannot hold a request past the granted time.
- No module asks for more yet. Sports (JS-301) will add its request after this merges.

Checked: unit tests for default, grant, clamp and bad requests; a slow host service (6
seconds) fails at 5 seconds without a request and succeeds with one; the host tests ran
natively and the Tasks module was built to WebAssembly and run on the real server over HTTPS
with a provider that takes 7 seconds. Without a request the route answered "unavailable"
after 5.2 seconds. With `callLimitMs` of 30,000 it answered normally. The server log held no
key and no private query text.

Not proven: a real AI model (the provider was a local stand-in with a fixed delay), a module
asking for the limit in the shipped Tasks package, and any user-visible screen (none changed).
