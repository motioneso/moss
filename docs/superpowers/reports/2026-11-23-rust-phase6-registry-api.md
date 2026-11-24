# JS-414: Phase 6 registry API

Implements approved part 8c on top of parts 1–8b. No screens, refresh scheduler,
account switches or install-request workflow are added.

- `GET/POST /api/modules/registries`: source health and pending source creation.
- `POST /api/modules/registries/{id}/confirm`: independently confirm the root fingerprint.
- `DELETE /api/modules/registries/{id}`: remove configuration; retain installed modules and data.
- `POST /api/modules/registries/import`: upload a JSON envelope with `id`, `rootKey`
  and a `files` map of relative signed-document/package names to base64 bytes.
  Import remains pending until the admin confirms its fingerprint. Uploaded bundles use the
  normal signed registry checks, including index expiry for new installations. They cannot
  supply the release-compiled offline-bootstrap allowlist.
- `GET /api/modules/list/export`: portable installed names, sources and optional pins.
- `POST /api/modules/list/preview`: a module-list file creates digest-bound operation reviews.
- `POST /api/modules/list/import`: accepts a saved `preview` ID and `approve: true`;
  execute the returned operation IDs through the existing operation journal. Existing names
  are left alone; omissions never request removal. Optional pins apply to new additions.

Authorization comes from the signed-in account. Pending source labels and keys are never
accepted as root confirmation. First-party publisher authority comes from existing trusted
host configuration and is pinned separately, including after the last source is removed;
uploaded files cannot choose it. Without provisioned first-party authority, namespaced registries can still be added,
but no registry publisher may claim a bare first-party name. Imported registry directories are host-owned. Responses project
identities, public fingerprints, health and reviews, omitting host paths and database logins.

## Verification state

The focused gate completed with exit 0: the real-server scenario passed, followed by all
21 existing publisher artifact tests. Its first green receipt was
`task_414_rust_phase_6_part_8c_registry_a-20261123-210552-bULCJL.log` at commit `8be7f8109`.
Ten guard-removal controls then completed with exit 0, each observing its expected assertion
fail (individual gate rc 101), and restored all source bytes. The final clean-head receipt
is supplied with the task's proof and PR. Full lint, formatting, file-size and TypeScript
checks passed, as did all 15 Rust gate-matrix routing tests.
The matrix was observed failing first without the new registry entry (14 pass, 1 fail).
Bundle manifest verification is shared with the publisher; the runner includes the existing
`phase6_registry_artifacts` tests. A source removal also marks its host configuration removed,
retaining trust history; an explicit same-root re-add restores it after replay checks.
The runner enforces one Cargo job, no debug information, and one test thread. Use from `~/Jarv1s`:

```bash
PATH=/tmp/js414-bin:$PATH CARGO_HOME=/tmp/js414-cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js414-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-registry-api
scripts/run-gate.sh wait --follow
```

Early gate launches stopped before exercising Rust: first a missing `tsx`, then missing
workspace dependency links. The declared offline workspace install repairs that setup.

## Failing-first evidence

- Before these endpoints, the real HTTPS gate against the pre-change shell failed with
  `registry management endpoint must exist`: HTTP 404 instead of 200 (gate rc 101).
- Review exposed a saved-history gap in the new API. The regression was observed failing:
  `re-add refuses replayed registry history`: HTTP 200 instead of 422 (gate rc 101).
  Add, confirm, file import and health now seed the shared validator from the canonical
  configuration history, read through the signed-in administrator's data context under
  the instance lock. This does not select private activation metadata.

## Review decisions

The first read-only review identified the history gap above and a pin-failure concern.
The parent already finalizes a failed child, but pin failure now also records an explicit
installed-without-pin result. Needlessly borrowed paths were removed.

Package sidecar signatures are optional: the index's package signature is always checked;
any supplied sidecar is checked too. List import uses ordinary per-module operation records,
so it may partially complete. Repeating a preview does not rerun terminal operations; the
existing executor returns their saved results. Preview records remain available for that
journal behavior. Skipped existing modules are currently omitted from the additions response.
Imported source folders remain after removal, and serial source health reads retain the
existing 30-second per-file network timeout while holding the management fence. Storage
reclamation, skipped-item presentation and finer health concurrency remain limitations.

## Not proven

- Screens, refresh scheduling, account switches and install requests are outside part 8c.
- Production deployment, platform parity and the full foundation/browser suites were not run.
- Offline file import uses signed fixtures through the real server; no production signing
  keys or release-compiled bootstrap allowlist were used.

## Guard-removal evidence

Run serially, with the same environment as the gate command above:

```bash
PATH=/tmp/js414-bin:$PATH CARGO_HOME=/tmp/js414-cargo RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js414-target CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 python3 rust-spike/module-host/tools/phase6-registry-controls.py
```

Observed exit 0. The controls removed the admin requirement, preview actor binding,
pending-source separation, exact fingerprint match, index signature verification,
publisher namespace authorization, both first-party name checks, bundle/index binding,
package digest verification and install expiry check. Each corresponding refusal assertion
failed after removal; none was counted from a compile or setup failure. The script restores
source files after each control. The replay regression above separately demonstrated failure
before the saved-history guard was added.

The Docker data partition filled during validation. A task-only scratch Docker invocation
wrapper selected by `PATH=/tmp/js414-bin:$PATH` mounted each disposable gate database's data
on the workspace disk and removed its files with the gate container. This changed storage
location only; the isolated verify-gate procedure, image and migrations stayed in use. No
shared database or other task's files were changed. With space on Docker's usual data disk,
the wrapper is unnecessary and the command can omit that PATH prefix.

The post-install pin failure message was not fault-injected. Successful pinned installation
was exercised through the real server. The reviewer and final proof distinguish that limit
from the guards tested above.
