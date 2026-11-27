# Docker-host move exporter (phase 7, part 16a)

`moss-docker-export` runs on Linux with the operator's Docker authority. It is a host move,
not an account export. It has no screen. Import, reconciliation, destination checks and activation
belong to parts 16b/16c; this command never starts the destination or restarts the source.

From `~/Jarv1s`, build with the declared Rust toolchain:

```bash
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo +1.95.0 build --locked \
  --manifest-path rust-spike/Cargo.toml -p moss-backup --bin moss-docker-export
```

Supply a JSON plan with the source identities (these are placeholders):

```json
{
  "project": "source-compose-project",
  "postgres": "source-postgres-container",
  "database": "jarv1s",
  "writers": ["source-app-container", "source-worker-container"],
  "externalSupervisorsDisabled": true,
  "mounts": [
    {
      "container": "source-app-container",
      "target": "/data/vaults",
      "archive": "vault",
      "disposition": "transferred"
    },
    {
      "container": "source-worker-container",
      "target": "/data/vaults",
      "disposition": "reconstructed",
      "reason": "The same source volume is captured from the app container"
    }
  ]
}
```

List every producer in `writers`, including combined supervisor containers, sidecars and agents.
Every container must belong to that Compose project. An unlisted running or restartable project
container blocks capture. Do not list the database twice. Every non-database mount needs exactly
one disposition:

- `transferred`: capture regular file bytes under a distinct `archive` root.
- `preserved-inactive`: capture bytes with a `reason`, for example module packages or CLI sessions
  needing qualification or sign-in. Import must not trust copied executable caches.
- `reconstructed`: record a `reason` without copying the mount, for example disposable sockets,
  model caches, or a second reference to an already captured volume. The operator is responsible
  for that classification; the exporter does not infer which mounts are expendable.

The database's `/var/lib/postgresql/data` mount travels as a custom dump; extra database mounts are
refused. Independent Notes roots and secret-file mounts must appear in the plan. Links and special
files block capture rather than silently disappear. Private paths, hashes, sizes, UID/GID/modes and
external-root mappings are inside the encrypted manifest. Import must map ownership and collisions.

Before confirming `externalSupervisorsDisabled`, disable host systemd/cron/Compose watchers and
external vault writers. Docker restart policies cannot prevent an outside service or operator from
explicitly starting a container. This flag records operator confirmation, not an OS service audit.
Writable-layer state outside mounted roots is not captured: first move any persistent unmounted
files into explicitly inventoried mounts.

Choose a new archive path in an existing private directory and run from a terminal:

```bash
moss-docker-export --config move-plan.json --output move.mossbak
```

The exporter reserves the archive and a synced owner-only `move.fence.json` receipt before changing
the source. It sets all selected restart policies to `no`, verifies them, and stops and verifies
every writer. It disconnects the database's networks, refuses remaining client sessions, then runs
that container's `pg_dumpall --roles-only` and `pg_dump --format=custom` via `docker exec`, a local
PostgreSQL socket and read-only transactions. Owners and ACLs remain in the dump. After dumping,
the database is stopped too. Failure leaves the fence in place and removes the incomplete archive;
it never automatically brings the source back online. The receipt retains IDs, prior policies and
network names for deliberate recovery. The exporter does not delete source volumes or images.

A fresh recovery key is shown once on the controlling terminal after the archive is synced. Keep
it privately, separately from the archive. Words never enter JSON output or the receipt. Automation
may use `--recovery-fd FD` with an inherited private pipe above fd 2; regular files and stdout/stderr
are refused. No phrase is supplied in arguments or environment variables.

The archive uses part 4's unchanged `MOSSBAK1` reader/writer. The fresh recovery key wraps a fresh
master key, which wraps the data key and the complete container environment bundle. That bundle
preserves both current/retired keyrings and their JSON ordering, OAuth/signing/session configuration
and database credentials. Nested family-key stores remain in the full dump. Role password verifiers
are also inside the encrypted payload. Password expansion happens inside the PostgreSQL container;
Docker and PostgreSQL diagnostics are withheld. Dump/mount bytes stream into archive entries,
without staging a plaintext copy on the host. Memory zeroization and protection from Docker
administrators are not claimed.

The encrypted `moss-docker-move` version 1 manifest records image versions and immutable image IDs,
core schema version, complete core/module migration ledgers, account count, tables/extensions,
dump/roles/file hashes and sizes, ownership intent, mount dispositions and source fence/inventory.
It also records credential portability caveats: originals are retained, but CLI, OAuth and OS-bound
sessions remain inactive until the importer qualifies them. Provider acceptance is not tested.

The `R` entry contains SQL roles, unlike native backups' roles JSON; `D` is a custom dump and `F`
entries are mapped mount files. Part 16b must dispatch on the authenticated manifest kind/version;
the native-instance restore drill is not a Docker move importer. Before activation, compare the
archive's authenticated source fence inventory against the live source using:

```bash
moss-docker-export check-fence move.fence.json
```

Never trust a sidecar receipt without comparing it to the authenticated archive inventory.

## Executable proof

```bash
RUSTUP_HOME="$HOME/.rustup" \
CARGO_TARGET_DIR=/media/$USER/Downloads/unity-scratch/JS-440/target \
pnpm test:rust-phase7-docker-export

RUSTUP_HOME="$HOME/.rustup" \
CARGO_TARGET_DIR=/media/$USER/Downloads/unity-scratch/JS-440/target \
python3 rust-spike/backup/tools/docker_export_negative_controls.py
```

The runner creates a random Compose project using the published Moss image, pgvector PostgreSQL,
a devports-reserved port, generated private credentials and independent volumes. It runs the
image's migrations/app/worker, seeds an account/item/attachment, exports and opens with the part 4
reader, verifies all file hashes, renders the dump with `pg_restore`, and byte-searches the archive
and diagnostics for generated plaintext credentials and words. It checks live fence drift and
archive damage. It cleans the stack, volumes, port, fixture scratch and newly pulled images without
force-removing shared images. The reader fixture handles synthetic data only; it is not an importer.

The runner does not reboot the shared host or Docker daemon. It inspects persisted restart
settings, explicitly starts only the throwaway writers to clear Docker's manual-stop bit, kills
their processes and verifies Docker's real restart manager leaves them stopped. This recreates
abrupt process loss locally. On a disposable GitHub-hosted Linux runner only, CI instead restarts
the actual Docker daemon after verifying every container belongs to this proof project. A full host
reboot remains unproven. The no-fence control removes policy
changes and the exporter's corresponding checks in source; the runner's independent reboot-condition
assertion must fail. The plaintext control appends the unwrapped generated bundle; the same byte
search must fail. Controls restore/rebuild production source in `finally`. No bypass switches ship.

Linux CI is sufficient for this Docker-host part. The existing archive-engine workflow still covers
shared backup code on Linux, macOS and Windows. CI uses this directory's small CI-only `devports`
implementation; local runs always use the shared host's reservation command.
