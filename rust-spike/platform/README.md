# Rust core platform, Phase 2b

Standalone Cargo workspace so JS-38 can build the safety core without sharing files.
These crates are executable foundations, not the replacement product binary.

```text
contracts   authenticated actor and metadata-only queue schema
jobs        new Postgres queue, retries, leases, idempotency and cron schedules
registry    manifests, route coverage, SQL ownership and queryable app map
routing     actor-scoped capability selection and transport ports
adapters    HTTP protocol details and non-serializable credentials
harness     gate-only HTTP hosts, parity and negative-control checks
```

From the repository root:

```bash
cargo test --manifest-path rust-spike/platform/Cargo.toml --workspace
python3 rust-spike/platform/tools/check-boundaries.py
python3 rust-spike/platform/tools/test-boundaries.py
python3 rust-spike/platform/tools/negative-controls.py
pnpm exec tsc -p rust-spike/platform/tools/tsconfig.json --noEmit
cargo +1.95.0 fmt --manifest-path rust-spike/platform/Cargo.toml --all -- --check
```

Read `.claude/skills/verify-gate/SKILL.md` before database work. The one supported
entry point uses a throwaway pgvector database, applies the existing migrations,
then tests queue persistence and sends parity requests to both HTTP hosts:

```bash
scripts/run-gate.sh start --gate ./rust-spike/platform/tools/gate.sh
scripts/run-gate.sh wait --follow
```

Ports are claimed through `devports`, then released in `finally`. Do not start the
harness hosts as a deployed server. The Rust host uses synthetic fixture sessions
and unauthenticated setup probes, requires the gate marker, and listens only on
loopback. It is never linked into a production binary.

## Safety-core joins

- Replace the host's actor construction with the safety core's session resolver.
- Implement `ConfigurationStore::for_actor` inside an actor-scoped DataContext.
  Supply only models/providers visible to that actor plus shared instance policy.
  The router never caches a global user's selection.
- Implement `EndpointStore::for_model` using the same actor context and cipher.
  Adapt decrypted credentials to `Secret`; never expose them to feature code.
- Implement `JobHandler::execute_in_data_context` with a fresh actor transaction
  and re-read resources there. Queue metadata alone grants no resource access.
- Apply `jobs/sql/0001_queue.sql` once through the safety core's migration ledger.
  It creates a new schema and never consumes or rewrites pg-boss history.
- Call `Registry::assert_coverage` on the actual server route inventory before
  listening. Only core routes belong in its platform allowlist.
- Add this workspace's build checks to the assembled application's build/CI gate.

The queue is at-least-once. Handlers need idempotent side effects or reconciliation;
a lease is not an exactly-once external-send guarantee. Callers driving `claim`
manually must renew before lease expiry and honor a failed renewal.

The product host owns configured listen addresses, HTTPS, trusted origins and
remote-browser sessions. See the Phase 2b report for tested scope and remaining
integration work. No production setting, UI or app-map entry changes in this slice.
