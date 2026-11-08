# Shared module UI kit

Initial Leptos versions of Park Press Button, Field, FormLabel, EmptyState and
Masthead, plus Calendar event chips, month cells and a native modal peek. Markup and options follow `packages/ui`; styling comes from its authored
CSS and the app tokens. This is a starting set, not a complete React component port.
Use `ssr` for native rendering tests and `csr` for browser WebAssembly builds.

```sh
cargo test --manifest-path rust-spike/module-ui/Cargo.toml --features ssr
cargo check --manifest-path rust-spike/module-ui/Cargo.toml --features csr --target wasm32-unknown-unknown
python3 rust-spike/module-ui/build-assets.py /tmp/moss-module-shared
node --test rust-spike/module-ui/web/bridge.test.mjs
```

The build script includes the canonical startup reset, expands canonical CSS imports and copies canonical fonts into
the selected output directory; generated assets stay out of commits. Serve that
directory at `/module-shared/`. Module screens use the host's opaque iframe and
`web/guest-bridge.mjs`, not direct authenticated HTTP. The signed-in parent installs
`web/host-bridge.mjs` and supplies its authenticated request and shell callbacks.
Attach the parent bridge before assigning the verified screen URL. The guest
constructs `moduleClient` during initial document startup, transferring a command
port before the first load. Only that document port carries commands; later
bootstrap messages are ignored even before navigation finishes. A missing initial
bootstrap or any later load revokes the bridge. Never automatically reconnect it.
Replies use transferred message ports so a navigated iframe cannot receive a
previous document's private response. Dispose both ends when their views close.
