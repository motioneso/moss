# JS-414: Phase 6 registry API

Implements approved part 8c on top of parts 1–8b. No screens, refresh scheduler,
account switches or install-request workflow are added.

- `GET/POST /api/modules/registries`: source health and pending source creation.
- `POST /api/modules/registries/{id}/confirm`: independently confirm the root fingerprint.
- `DELETE /api/modules/registries/{id}`: remove configuration; retain installed modules and data.
- `POST /api/modules/registries/import`: upload a JSON envelope with `id`, `rootKey`,
  `firstPartyKey` and a `files` map of relative signed-document/package names to base64 bytes.
  Import remains pending until the admin confirms its fingerprint. Uploaded bundles use the
  normal signed registry checks, including index expiry for new installations. They cannot
  supply the release-compiled offline-bootstrap allowlist.
- `GET /api/modules/list/export`: portable installed names, sources and optional pins.
- `POST /api/modules/list/preview`: a module-list file creates digest-bound operation reviews.
- `POST /api/modules/list/import`: accepts a saved `preview` ID and `approve: true`;
  execute the returned operation IDs through the existing operation journal. Existing names
  are left alone; omissions never request removal. Optional pins apply to new additions.

Authorization comes from the signed-in account. Pending source labels and keys are never
accepted as root confirmation. Imported registry directories are host-owned. Responses project
identities, public fingerprints, health and reviews, omitting host paths and database logins.

## Verification state

Implementation checkpoint; focused real-server verification and negative controls pending.
Scoped ESLint, Prettier, `pnpm check:file-size`, and the Rust CI matrix's 15 Node tests pass.
The matrix was observed failing first without the new registry entry (14 pass, 1 fail).
Bundle manifest verification is shared with the publisher; the runner includes the existing
`phase6_registry_artifacts` tests. A source removal also marks its host configuration removed,
retaining trust history; an explicit same-root re-add restores it after replay checks.
The runner enforces one Cargo job, no debug information, and one test thread. Use from `~/Jarv1s`:

```bash
CARGO_HOME=/tmp/js414-cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js414-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-registry-api
scripts/run-gate.sh wait --follow
```

Early gate launches stopped before exercising Rust: first a missing `tsx`, then missing
workspace dependency links. The declared offline workspace install repairs that setup.
