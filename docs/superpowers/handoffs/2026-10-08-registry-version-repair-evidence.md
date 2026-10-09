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
scheduled-task proof. It leaves the recorded [Main repair](2026-10-08-3125-main-reopen-repair-evidence.md)
at source/runtime/harness `01a014e1`, [email-choice](2026-10-08-3129-evidence.md)
at source/harness `fa397bcb5`, and [quiet-boundary](2026-10-08-3158-evidence.md)
at source/harness `184dfd458` unchanged. Those receipts remain limited to their
documented scenarios and do not establish that scheduled tasks exist or were
exercised.

## Published-index provenance

The read-only `modules` release index was downloaded on 2026-10-08. Its release
asset was created and last updated at `2026-10-08T01:01:18Z`; the index has
SHA-256 `8b6cb44748c979c1e70618e3f0eb3eb9202c1006a2879dc43bc439c2a73ee3e5`
and `generatedAt` `2026-10-08T01:01:16.816Z`.

The index contains Finance `0.5.14` and Food `0.3.7`; neither proposed
replacement version appears among current or retained versions. The release
metadata and asset were read only. No registry publish, signing operation, or
integrity-guard change was attempted.

Against the verified base, the registry-input source diff contains only the two
manifest files. Their replacement-input SHA-256 values are Finance
`f3de66e0b0fb5c86002e74c36c88b8a9598d73dc6ffd761591e7cf0186a8a2a9` and
Food `6ee12fb9ea86126f78d720d2dd97b9f0bae51cbd7310ea5629a5a024f31f1bb4`.
The unchanged publisher script hash is
`2481d023f5eeadbf6ed3aa68a120ce4941894c282abf6f98e9a12f0550897fab`.

## Red/green publisher evidence

The exact CI run for the verified base,
[`37893433995`](https://github.com/motioneso/moss/actions/runs/37893433995),
used Node `24.21.0` and pnpm `10.6.2`. Its real
`publish-module-registry.ts --check` command exited 1 and rejected only Finance
`0.5.14` and Food `0.3.7` for changed SHA-256 and size.

The authoritative local pair used fresh `git archive` sources, a read-only
mounted index, and a frozen install inside the same disposable
`node:24.21.0-bookworm` container. Before the CLI, each run asserted that the
mounted file was nonempty, parsed as an index containing Finance and Food, and
had SHA-256 `8b6cb44748c979c1e70618e3f0eb3eb9202c1006a2879dc43bc439c2a73ee3e5`.
The base archive (`ab057308`, archive SHA-256
`0775c332a32f0e7d1fd34fd43f6471d1aefa248b4f0c65e2da2b46e250a3893a`)
exited 1 for only Finance and Food. The candidate archive (`44d381d`, archive
SHA-256 `e6150090828056d24a72e6de2bf17220ffb49a71895a876bf7e13940432c7ca9`)
exited 0 with `registry check: 3 module(s) publishable`. Both ran:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tsx scripts/publish-module-registry.ts \
  --check --out /tmp/registry-check --previous-index /published-index/index.json
```

An earlier host-mounted container probe did not mount the published index and
is excluded from the result above. A separate host-local diagnostic with the
released index reported Job Search `0.2.15`; it was investigated rather than
used to bump a third module:

- The published and local Job Search tarballs unpack to identical trust-set
  files (`jarvis.module.json`, `dist/**`, and `sql/**`), while their gzip
  containers differ by one byte in total size (75,146 vs 75,145) and SHA-256.
- Their gzip headers are identical. The first compressed-payload difference is
  one-indexed byte 3,744 (`0o355` published, `0o343` local); the compressed
  streams have further differences but unpacked files compare equal.
- The CI run at the same source SHA did not reject Job Search, and the
  authoritative candidate archive did not reject it. The container used Node
  `24.21.0`, zlib `1.3.2.1-motley-8002e91`, and pnpm `10.6.2`. Its image digest was
  `sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0`;
  its Node binary SHA-256 was
  `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.

The archive pair corroborates the CI result but does not replace the
pull-request workflow as final registry evidence. Job Search remains unchanged
because no canonical CI rejection or matching-input check supports a new
immutable release version.

## Checks

Commands used Node `24.21.0` and pnpm `10.6.2`, except where noted above. The
publisher row is the later, paired `44d381d` archive check described above. The
unit, lint, format, file-size, and type rows ran before the first evidence
document was added, with only the two uncommitted manifest version edits. They
are meaningful checks for those inputs, not a clean-commit certification.

| Command | Result |
| --- | --- |
| `pnpm vitest run tests/unit/publish-module-registry.test.ts` | 1 file, 23 tests passed |
| `pnpm lint` | passed |
| `pnpm format:check` | passed |
| `pnpm check:file-size` | passed; no checked file exceeds 1,000 lines |
| `pnpm typecheck` | passed, including root, test, web, and external-module checks |
| Publisher check in frozen disposable Node container with mounted index | passed: 3 modules publishable |

The failed pre-edit publisher check is the meaningful red proof. No mirrored
JSON-only test was added for the two one-line version changes; the publisher
already validates and packages the modified manifests through its production
seam.

## Review, cleanup, and remaining verification

The freeze candidate changes only the two manifest version fields and this
evidence file. Standards review was green at `48fbed288`. The initial Spec
review rejected only the former overbroad proof sentence; this documentation
delta corrects it without changing publisher inputs. Its focused follow-up Spec
review was green at `eb287e110`; the manifest hashes and publisher inputs are
unchanged.

The disposable Node containers exited and were removed. Private logs, the
downloaded published index, and the archive used for the red proof remain in
the task-private evidence directory until coordinator audit; no registry asset,
shared database, server, browser, development port, or root-held image was
changed. The coordinator must obtain the reviewed candidate's pull-request
`modules-registry-check` result before treating the registry as canonically
green.
