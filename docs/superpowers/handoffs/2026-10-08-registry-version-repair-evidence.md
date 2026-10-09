# Module registry version repair evidence

## Scope

This metadata-only repair advances the versions of the two module artifacts that
the registry's immutable-version guard rejected at the verified integration base
`ab057308fd98db96febe326c7e4c98cecc55f802`:

| Module | Rejected version | Replacement version |
| --- | --- | --- |
| Finance | `0.5.14` | `0.5.15` |
| Food | `0.3.7` | `0.3.8` |

No runtime, UI, worker, or app-map behavior changed. This repair claims no
scheduled-task proof. It leaves the recorded Main-chat proof at source
`50c8f807b718d4b251dc57a73fbc8bede8dc517a` with harness
`7f0fa287754fa993977637a7faff656d11f48bce`, the email-choice proof at
source/harness `cd264147988a3b4f1484855b23d7cc02e8fbd607`, and the
quiet-boundary proof at source/harness
`184dfd4588bcbce2c9abd2c2f97ed7c0c7e1bb0d` unchanged. Those receipts remain
limited to their documented scenarios and do not establish that scheduled tasks
exist or were exercised.

## Published-index provenance

The read-only `modules` release index was downloaded on 2026-10-08. Its release
asset was created and last updated at `2026-10-08T01:01:18Z`; the index has
SHA-256 `8b6cb44748c979c1e70618e3f0eb3eb9202c1006a2879dc43bc439c2a73ee3e5`
and `generatedAt` `2026-10-08T01:01:16.816Z`.

The index contains Finance `0.5.14` and Food `0.3.7`; neither proposed
replacement version appears among current or retained versions. The release
metadata and asset were read only. No registry publish, signing operation, or
integrity-guard change was attempted.

## Red/green publisher evidence

The exact CI run for the verified base,
[`37893433995`](https://github.com/motioneso/moss/actions/runs/37893433995),
used Node `24.21.0` and pnpm `10.6.2`. Its real
`publish-module-registry.ts --check` command exited 1 and rejected only Finance
`0.5.14` and Food `0.3.7` for changed SHA-256 and size. An independent
disposable archive of that same base reproduced the red result (terminal exit
1) in the matching Node container after `corepack pnpm install
--frozen-lockfile`, using:

```sh
corepack pnpm tsx scripts/publish-module-registry.ts \
  --check --out /tmp/registry-check --previous-index /published-index/index.json
```

Before editing, the same local CLI command with the released index also exited
1 for those two artifacts. It additionally reported Job Search `0.2.15`.
That local discrepancy was investigated instead of bumping a third module:

- The published and local Job Search tarballs unpack to identical trust-set
  files (`jarvis.module.json`, `dist/**`, and `sql/**`), while their gzip
  containers differ by one byte in total size (75,146 vs 75,145) and SHA-256.
- Their gzip headers are identical. The first compressed-payload difference is
  one-indexed byte 3,744 (`0o355` published, `0o343` local); the compressed
  streams have further differences but unpacked files compare equal.
- The CI run at the same source SHA did not reject Job Search. The same
  disposable `node:24.21.0-bookworm` input image, using Node `24.21.0`, zlib
  `1.3.2.1-motley-8002e91`, pnpm `10.6.2`, the published-index digest above,
  and the actual CLI command, exited 0 with `registry check: 3 module(s)
  publishable` after the two version edits. The image digest was
  `sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0`;
  its Node binary SHA-256 was
  `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.

The disposable container corroborates the CI result but does not replace the
pull-request workflow as final registry evidence. Job Search remains unchanged
because no canonical CI rejection supports a new immutable release version.

## Checks

All commands ran from `~/Jarv1s-scheduled-registry-fix` with Node `24.21.0`
and pnpm `10.6.2`, except where noted above.

| Command | Result |
| --- | --- |
| `pnpm vitest run tests/unit/publish-module-registry.test.ts` | 1 file, 23 tests passed |
| `pnpm lint` | passed |
| `pnpm format:check` | passed |
| `pnpm check:file-size` | passed; no checked file exceeds 1,000 lines |
| `pnpm typecheck` | passed, including root, test, web, and external-module checks |
| Publisher check in disposable matching Node container | passed: 3 modules publishable |

The failed pre-edit publisher check is the meaningful red proof. No mirrored
JSON-only test was added for the two one-line version changes; the publisher
already validates and packages the modified manifests through its production
seam.

## Review, cleanup, and remaining verification

The freeze candidate changes only the two manifest version fields and this
evidence file. Standards review was green at
`48fbed288b0a0c1a1a1f0fac1faff7a3fb0bd25f`. The initial Spec review rejected
only the former overbroad proof sentence; this documentation delta corrects it
without changing publisher inputs. Its follow-up review remains required.

The disposable Node containers exited and were removed. Private logs, the
downloaded published index, and the archive used for the red proof remain in
the task-private evidence directory until coordinator audit; no registry asset,
shared database, server, browser, development port, or root-held image was
changed. The coordinator must obtain the reviewed candidate's pull-request
`modules-registry-check` result before treating the registry as canonically
green.
