# Moss module SDK

Pure guest contracts for first-party module packages. No host crate, async runtime,
filesystem, socket or thread dependency is allowed here.

`Host::call(port, operation, resource, parameters)` is the single host edge. `Client`
provides typed database and public API helpers. API calls always nest arguments in
`{name, parameters}`; route-shaped arguments remain ordinary provider data.

The additive database operation is `db/query` on a declared owned table. Its JSON
contract is defined in `src/query.rs`. It supports select/insert/update/delete,
typed conjunction/disjunction/comparison/null/membership filters, ordering, bounded
paging and conflict-ignore inserts. Composite keys use a filter conjunction; they
do not require a synthetic `id` column. The host supplies ownership, never the guest.
`Filter::Owned` names the current host-authenticated account without disclosing or
accepting an actor selector. SQL strings and unknown contract fields are refused.

The existing `db/select`, `db/insert`, `db/update` and `db/delete` envelopes remain
the Phase 4b contract. New packages must explicitly declare the `query` capability.

`RouteRequest` describes the new parameterized dispatcher. Existing literal dispatch
continues accepting its original method/path/body envelope.

Run native contract tests with:

```sh
cargo +1.95.0 test --locked --manifest-path rust-spike/module-sdk/Cargo.toml
```
