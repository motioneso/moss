# Calendar Rust package: slice one

Part of #4027. This is the package and data foundation, **not the full Calendar port**.
The existing TypeScript app stays in place. Screens, settings writes, chat tools, jobs,
provider execution and the assembled HTTP/UI parity gate belong to the next two slices.

The guest in `src/` depends only on the SDK and pure Rust libraries. Its six storage routes
and five public methods expose cached events, day-plan draft reads/create/save, and legacy
briefing-settings reads. These are the data layer; the later UI adapter must retain the
existing HTTP request envelopes, default timezone and contextual response projections.

`moss.module.json` declares all five existing Calendar tables, their privacy classification,
and the fifteen original SQL identities. Packaging reads `packages/calendar/sql/` and checks
its bytes against the compiled inventory. It never copies new SQL over the TypeScript source.
Events retain owner-or-explicit-share rules. Plans, blocks, operations and operation items
retain owner-only rules. A draft cannot overwrite recorded placement.

`host/` is a **trusted host wrapper**, separate from the guest. Use `CalendarPorts::new` in
`Application::open_extended_with`. It reads only the seven existing Calendar preference keys
through the authenticated data context. `with_references` accepts actor-scoped public Tasks and
Briefing projections; no other module's tables are queried here. Without those projections,
drafts containing task references or a source run fail before committing. The returned task
shape is `{task:{id,ownerUserId}}`; the briefing shape is `{run:{id,ownerUserId}}`. The later
composition must provide real public adapters and validate full source-run provenance before
exposing the original HTTP create route. These projections are host-injected services, not
undeclared module-to-module dispatch. No People data is read by this slice.

## Build and verify

Use the project's existing Rust toolchain with its `wasm32-unknown-unknown` target. Set
`CALENDAR_RUSTUP_HOME` if it is in a task-local Rust home. No tool is installed by these scripts.

```sh
modules/calendar/tools/check.sh
scripts/run-gate.sh start --gate ./modules/calendar/tools/gate.sh
scripts/run-gate.sh wait --follow
```

`check.sh` builds the native tests and Rust Wasm library, compares pure data behavior with the
existing TypeScript implementation, and loads the shipped component with the real host.
The package builder wraps the pure core library in the existing `moss:module` component ABI
without WASI imports. It uses `wasm32-unknown-unknown`, rather than the spec's proposed
`wasm32-wasip2` compiler target; the shipped artifact is still a component. This avoids adding
a binding generator or a second WASI interface to the host. This target choice must remain
visible when the combined package build is standardized in the final slice.

The disposable database gate additionally downloads and installs a locally signed test
registry package, exercises real Wasm data calls, checks draft revision conflicts/rollback,
and runs the same foreign read/write assertions with row security removed and restored.
Those temporary fixtures are not UI or second-device proof.

To emit an unsigned registry archive after `check.sh`:

```sh
cargo +1.95.0 run --locked --offline --manifest-path modules/calendar/host/Cargo.toml \
  --bin calendar-package -- \
  /tmp/js48-host-target/calendar-guest/wasm32-unknown-unknown/release/moss_calendar.wasm \
  /tmp/calendar.mosspkg
```

A production registry must sign the digest using its approved first-party publisher. Tests
use fresh ephemeral keys and do not establish a production publishing configuration.
