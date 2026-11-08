# Shared module UI kit

Initial Leptos versions of Park Press Button, Field, FormLabel, EmptyState and
Masthead. Markup and options follow `packages/ui`; styling comes from its authored
CSS and the app tokens. This is a starting set, not a complete React component port.
Use `ssr` for native rendering tests and `csr` for browser WebAssembly builds.

```sh
cargo test --manifest-path rust-spike/module-ui/Cargo.toml --features ssr
cargo check --manifest-path rust-spike/module-ui/Cargo.toml --features csr --target wasm32-unknown-unknown
python3 rust-spike/module-ui/build-assets.py /tmp/moss-module-shared
node --test rust-spike/module-ui/web/bridge.test.mjs
```

The build script expands canonical CSS imports and copies canonical fonts into
the selected output directory. Shared document foundations apply the authored
sans body type, display headings and sizing inside isolated frames, which cannot
inherit parent styles. Generated assets stay out of commits. Serve that
directory at `/module-shared/`. Module screens use the host's opaque iframe and
`web/guest-bridge.mjs`, not direct authenticated HTTP. The signed-in parent installs
`web/host-bridge.mjs` and supplies its authenticated request and shell callbacks.
Pass the installer-verified `screenUrl` in the parent bridge's options; the bridge
attaches its listeners and opens that URL with a random document key in the fragment.
The guest constructs `moduleClient` during initial document startup, transferring a
command port with that key. The queued connection message may arrive before or after the first load.
Another document without that key cannot claim the waiting connection. Legacy
callers that assign the URL themselves keep the original strict startup timing;
they must supply `screenUrl` to support either event order.
Only the accepted document port carries commands; later bootstrap messages are
ignored even before navigation finishes. Any subsequent load revokes the bridge,
including a bridge that has not yet connected. Never automatically reconnect it.
Replies use transferred message ports so a navigated iframe cannot receive a
previous document's private response. Dispose both ends when their views close.
