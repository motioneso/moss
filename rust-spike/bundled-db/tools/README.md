# Phase 7 pinned database bundle

`sources.json` pins PostgreSQL 17.11 and pgvector 0.8.7 source archives by SHA-256.
Windows also builds ICU, zlib and zstd from pinned source; Unix uses the ICU development files
already required by the Phase 1 proof and copies the runtime library closure.
The Windows supervisor workflow uses this builder instead of runner Postgres.

Builds and downloaded archives stay outside the repository. Each cached archive
is named by its SHA-256 and verified again on every use. CI caches only these
archives, keyed by the source lock file; it does not cache installed databases.
Use fresh build and output folders for a rebuild. No signing identity is used.
macOS applies only the ad-hoc signatures needed to run modified arm64 Mach-O files.

## Build and prove

Linux needs the C toolchain, make, bison, flex, Perl, ICU, zlib and zstd development files.
macOS needs Xcode tools and the existing Homebrew bison, flex, ICU and zstd dependencies.
Windows needs a VS developer shell, CMake, Perl and MSYS bison/flex; ICU is compiled
by MSBuild. CI installs Meson and Ninja with `pip --require-hashes` from
`requirements-ci.txt`. These two tools are approved for CI only, not the local box.

From `~/Jarv1s`, with the task scratch directory on the large disk:

```sh
python3 rust-spike/bundled-db/tools/build-pg-bundle.py --scratch "$MOSS_SPIKE_SCRATCH" --out "$MOSS_SPIKE_SCRATCH/pg-built"
mv "$MOSS_SPIKE_SCRATCH/pg-built" "$MOSS_SPIKE_SCRATCH/postgres relocated"
pnpm test:rust-phase7-pg-bundle --postgres "$MOSS_SPIKE_SCRATCH/postgres relocated" --scratch "$MOSS_SPIKE_SCRATCH/proof"
python3 rust-spike/bundled-db/tools/bundle-negative-controls.py --postgres "$MOSS_SPIKE_SCRATCH/postgres relocated" --scratch "$MOSS_SPIKE_SCRATCH/proof"
```

The named runner is `phase7_pg_bundle`. It uses only absolute bundled tool paths,
checks their recorded digests and the source lock, starts an isolated throwaway
cluster on loopback, checks ICU initialization and both extension/server versions,
creates a vector row, dumps it with `pg_dump` using both gzip and zstd, restores into
fresh databases with `pg_restore`, and checks the row. Linux also checks that the
runtime library closure resolves inside the bundle apart from glibc. Inherited libpq settings are discarded.
It stops its own server and removes its own cluster even after a failed assertion.
It never connects to the developer's database.

CI moves the installed bundle and deletes its source/build tree before running
the proof, so a surviving build-prefix dependency fails the test. Negative controls
remove each backup tool in turn and require an actual gate exit other than zero
with the missing-tool error. Windows additionally puts the runner's real Postgres
first on PATH and requires the gate to reject that selection. Pass its bin folder
as `--runner-bin` to the negative-control script on Windows. The positive Windows
run requires PATH to select the bundle for every tool.

`stage-install.py` also refuses a bundle missing either backup tool. Native
installer layout, services, backup commands and real signing belong to later parts.
