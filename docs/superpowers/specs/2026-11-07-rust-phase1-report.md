# Rust port, Phase 1: platform floor (bundled database)

- Task: JS-37. Part of #4027.
- Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 1.
- Rules: `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`, sections
  "Database", "Fresh install", "At-rest claims" and gate G1.
- Code: `rust-spike/bundled-db/`, in the throwaway `rust-spike/` workspace. `rust-spike/README.md`
  says how to run it.
- Run on 2026-11-07. Linux with cargo 1.95.0. macOS by hand, because the test Mac has no Rust.
- Postgres 17.11 and pgvector 0.8.7, built from source.
- Log numbers below name the files attached to the task's proof.

## Summary

One Rust program, `moss-db`, runs a private, bundled Postgres with pgvector for one install. On
Linux it creates the database, runs all 331 of the app's built-in migrations, answers a vector
query, stops cleanly and restarts with the data intact. It recovered from every crash tried. The
same flows passed on macOS, run by hand against the same Postgres build. Windows is designed below
but nothing ran on it.

Neither kill gate fires. Neither is closed, because closing them needs a Developer ID for the Mac
and a Windows machine.

| Brief item                                    | Result                                     | Main evidence                                                                                     |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1. Start, migrate and stop a bundled Postgres | Holds on Linux                             | 331 migrations applied. The vector query uses its index. Clean stop in 0.4 s.                     |
| 2. Linux restart and crash recovery           | Holds                                      | Seven crash and leftover cases recover with data intact. The machine's own Postgres is untouched. |
| 3. macOS, including signing                   | Holds by hand; notarization untested       | The same flows pass. A signed app loads pgvector once library validation is satisfied or relaxed. |
| 4. Windows without admin, with named pipes    | Designed, untested                         | The approach below names each unknown.                                                            |
| 5. Disk-encryption report                     | Holds on Linux; Mac checks matched by hand | Linux reports "off" and claims nothing. The Mac reads FileVault on, encrypted swap.               |
| 6. How to bundle Postgres                     | Decided                                    | Build it ourselves from checked source. 23 MB on Linux, 56 MB on the Mac.                         |

The tests were seen to fail as well as pass. Each of the three disk-encryption protections was
removed in turn, and each time exactly one test failed (log 33).

The plan's Phase 1 kill gate reads "if pgvector cannot load under macOS notarization, or Postgres
cannot run as a normal Windows user":

- **macOS: does not fire.** pgvector loads in a signed app. The only blocker found was library
  validation, and it refused every bundled library, not just pgvector. Both fixes are known, and
  one was proven. Closing the gate needs notarization with a Developer ID.
- **Windows: does not fire, not closed.** Nothing ran on Windows.

Phase 2 was not started. The plan's keys bullet (unlock and recover in a real install) is outside
this task.

## What was built

| File             | What it does                                                               |
| ---------------- | -------------------------------------------------------------------------- |
| `src/main.rs`    | `moss-db` with `init`, `up`, `stop`, `status`, `check`, `hold`, `at-rest`  |
| `src/cluster.rs` | The supervisor. Creates, starts, stops and recovers the database           |
| `src/migrate.rs` | Runs the app's migrations the way `scripts/migrate.ts` does, minus pg-boss |
| `src/procs.rs`   | Finds this install's leftover database processes and nothing else          |
| `src/layout.rs`  | One private folder per install                                             |
| `src/at_rest.rs` | Verified, off or unknown for each place data can land                      |
| `src/secrets.rs` | Generated passwords in owner-only files, standing in for the OS key store  |
| `pg-module/`     | `moss_nodump`, a Postgres add-on that makes the database non-dumpable      |
| `proof/linux/`   | Builds the Linux bundle and runs the crash and leftover proofs             |
| `proof/mac/`     | The same flows by hand on a Mac, plus the signing tests                    |

### One install

| Rule                         | How `moss-db` meets it                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| One data folder per install  | A root folder (mode 700) holds `db`, `run`, `secrets`, `logs` and a lock file                            |
| No admin rights              | Runs as the user. Writes only inside the root folder, plus a short socket folder if the path is too long |
| Local-only connections       | A private socket by default, with no TCP listener. TCP only on request, and only on loopback             |
| Generated credentials        | Random passwords for the superuser and the four app roles. Every connection must use SCRAM               |
| One supervisor per install   | A lock on the lock file. A second supervisor exits with "another supervisor ... is already running"      |
| A free port when needed      | `up --tcp` tries a port range and skips ports another program holds                                      |
| Never touch another Postgres | A leftover must be this user's `postgres` and name this install's data folder or cluster name            |
| Setup survives a power cut   | The new database is built in `db.partial` and renamed when complete. A rerun starts that step over       |

The cluster itself:

- initdb sets UTF-8, data checksums, SCRAM for every connection, ICU root collation (`und`) and the
  C locale for everything else.
- Start settings turn off the TCP listener, set the socket to mode 0700, turn off SSL (there is no
  network) and set `max_connections=50`.
- The cluster name is `moss-` plus 12 hex digits of the data folder's hash. Server process titles
  carry it, so leftovers from this install can be told apart from any other Postgres.
- Postgres runs with a zero core-dump limit.
- The four app roles (`jarvis_app_runtime`, `jarvis_auth_runtime`, `jarvis_migration_owner`,
  `jarvis_worker_runtime`) are not superusers and do not bypass row-level security.
- On Linux Postgres gets a parent-death signal, so killing the supervisor shuts the database down.
  macOS has no such signal, so the next start cleans up instead.
- If the socket path would pass 104 bytes, the socket moves to a short folder in the user's
  runtime or temporary folder.

### Migrations

- The order matches the app. Bootstrap SQL runs as superuser under the cluster lock, then the role
  passwords are set, then each of 27 folders runs as `jarvis_migration_owner`.
- The checksum table, transactions, legacy shims and lock match the app's runner. The checksums come
  from Phase 0a's code.
- There are 331 files, 30 in `infra/postgres/migrations` and 301 in 26 module `sql/` folders. These
  are the same 331 files Phase 0a checked. Phase 0a's other 80 files belong to external modules,
  which run when a module is installed.
- Two migrations have a JavaScript backfill (`0280_meeting_history`, `0292_meeting_minimal`). On a
  fresh install their loops find no rows, so `moss-db` runs only their closing statements. Each
  backfill is pinned to its exact bytes. A changed file, or a table with rows, stops the migration.

## Linux evidence

The machine runs Ubuntu 24.04 LTS on x86_64, with kernel 6.8 and glibc 2.39.

| Case                              | What happened                                                                                                                                                                | Log       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| First run                         | Created the cluster and applied 331 migrations. initdb 848 ms, start 113 ms, migrations 2.2 s. SIGTERM gave a clean stop in 403 ms                                           | 01        |
| Check                             | Postgres 17.11, checksums on, vector 0.8.7, 331 migrations recorded. The app role is not a superuser and does not bypass RLS                                                 | 03        |
| Vector query                      | Nearest to [0.9,0.6,0] is north-east (0.2236), then east (0.6083). The plan is "Index Scan using items_embedding"                                                            | 03        |
| Permissions and refusals          | Folders 700, files 600, socket 700. A wrong password gives "password authentication failed". No password gives "fe_sendauth: no password supplied"                           | 04        |
| Second supervisor                 | Refused with "another supervisor (pid N) is already running this install", exit 1                                                                                            | 04        |
| Listeners                         | Only the private socket. The machine's own Postgres on port 5432 kept running, untouched                                                                                     | 04b       |
| Stop and restart                  | Stop 452 ms. The restart applied 0, found 331 already applied and kept the test row                                                                                          | 05-07     |
| Database killed                   | The next start replaced the stale lock file and recovered. Both test rows were present                                                                                       | 08-09     |
| Busy query when the database dies | Ended with "terminating connection because of unexpected SIGQUIT"                                                                                                            | 10        |
| Leftover worker                   | A busy backend outlived its killed postmaster. Plain Postgres then refuses to start ("pre-existing shared memory block ... is still in use"). `moss-db` ended it and started | 11-13, 29 |
| Supervisor killed                 | Postgres got a fast shutdown and stopped by itself. The next start was clean                                                                                                 | 14-15     |
| Database left running alone       | A database with no supervisor was stopped cleanly, then started again                                                                                                        | 16, 30    |
| Lock file names a reused pid      | Plain Postgres refuses ("lock file "postmaster.pid" already exists"). `moss-db` left the other program running and removed only the stale lock file                          | 17-18, 31 |
| Second install on TCP             | Skipped port 5193, which another program held, and used 5194. Applied 331. The first install was unaffected                                                                  | 19-20     |
| Bundle moved                      | The bundle runs from any folder, because each binary finds its libraries relative to itself                                                                                  | 21        |
| Power cut during first setup      | Killing the supervisor 0.35 s into setup left an unfinished folder and no initdb process. The rerun built the database again and applied 331                                 | 22        |

Unit tests pass, 23 in `bundled-db` and 76 across the workspace.

### Crash dumps on Linux

A zero core-dump limit is not enough on Ubuntu. The kernel hands every crash to the crash-handler
program (apport) whatever the limit. Without the add-on, a crashed backend reached apport, which
logged "called for global pid N, signal 11, core limit 0, dump mode 1" (logs 24, 28d). apport
dropped the dump only because the binary "does not belong to a package". A packaged Moss would not
be that lucky.

`moss_nodump` makes each database process non-dumpable as Postgres loads it. With the add-on
(logs 26-27):

- all 6 processes show as non-dumpable and still run as the user, with a zero limit
- a crash produced no crash-handler line and nothing in `/var/crash`
- Postgres logged the crash, reset itself and was ready again

A non-dumpable process hides its working folder and binary link in `/proc`. The leftover finder
reads the command line instead, which stays readable.

### Disk-encryption report on Linux

`moss-db at-rest` checks each place Moss data can land and reports verified, off or unknown. It
claims protection only when every check is verified. On the test machine (log 34):

| Place           | Verdict  | Why                                                               |
| --------------- | -------- | ----------------------------------------------------------------- |
| Database folder | Off      | A plain partition. Drive-level hardware encryption is not checked |
| Logs            | Off      | Same partition                                                    |
| Home folder     | Off      | A plain partition                                                 |
| Swap            | Off      | A swap file on the plain root partition                           |
| Shared memory   | Unknown  | `/dev/shm` lives in memory and may be swapped out                 |
| Crash dumps     | Verified | "all 6 database processes are non-dumpable"                       |
| Overall         | Off      | Protection is not claimed                                         |

The message shown is "Disk encryption is off for: Database folder, Logs, Home folder, Swap. Anyone
who gets this disk can read Moss data. Moss makes no claim that data on disk is protected."

Without the add-on the crash-dump check reports unknown, because "the kernel ignores that limit when
it hands a dump to a crash-handler program" (log 28c). An earlier version reported verified in that
case (log 23). The fix replaced it.

Each protection was removed in turn, and exactly one test failed each time (log 33):

| Protection removed                                 | Test that failed                                          |
| -------------------------------------------------- | --------------------------------------------------------- |
| Distrust a zero limit when a crash handler is set  | `a_zero_limit_is_verified_only_when_dumps_go_to_a_file`   |
| Claim protection only when every check is verified | `protection_is_claimed_only_when_every_check_is_verified` |
| Read each process's dump state correctly           | `classify_reads_the_dump_state`                           |

## macOS evidence

The Mac runs macOS 26.5.2 on Apple silicon. It has no Rust, and the brief said to install nothing
without asking. So the flows ran as shell scripts (`proof/mac/`) that do what `moss-db` does. The
Rust code's Mac paths type-check on Linux (mac-04) but have never run.

Postgres and pgvector were built on the Mac from the same checked source. The bundle points every
library path at `@executable_path/../lib`. Only the system zlib and libSystem come from outside it.

| Case                  | What happened                                                                                                                                              | Log            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Lifecycle             | initdb 559 ms, start 77 ms. No network sockets, socket mode srwx------. A wrong password was refused. Clean stop 67 ms, restart 72 ms                      | mac-01         |
| Check                 | "PostgreSQL 17.11 on aarch64-apple-darwin25.5.0", checksums on, ICU root collation. The vector query matches Linux and uses the index                      | mac-01         |
| Sort order            | ICU sorts "apple Eagle éclair Zebra", the same as on Linux                                                                                                 | mac-01         |
| Database killed       | Recovered ("not properly shut down", then redo). Both test rows present, 0 checksum failures                                                               | mac-01         |
| Leftover worker       | As on Linux, a busy backend outlives its postmaster and blocks a plain start. Ending the processes with this install's title fixed it                      | mac-01         |
| Crash dumps           | `/cores` belongs to root and is not writable, so no core file appeared even with no limit. macOS still writes a crash report (.ips)                        | mac-02, mac-03 |
| Crash report contents | 9 KB, owner-only (0600). Registers, a 20-frame stack, memory region names and loaded libraries. No test data found. The home folder shows as "/Users/USER" | mac-03         |
| Disk encryption       | "FileVault is On." The data volume reports FileVault for the Moss data folder and the crash-report folder. Swap reports "(encrypted)"                      | mac-08         |

### Signing

Signing with a real identity needs the login keychain unlocked, which SSH cannot do
("errSecInternalComponent"). The tests used ad hoc signing instead, which goes through the same
runtime checks but cannot be notarized.

- 75 files were signed (40 libraries, 35 programs). Strict verification passed on all of them
  (mac-05, mac-07).
- With the hardened runtime on, the first launch failed with "Library not loaded:
  @executable_path/../lib/libpq.5.dylib ... mapping process and mapped file (non-platform) have
  different Team IDs". postgres failed the same way on libzstd. Library validation refuses every
  bundled library whose signature does not share the program's Team ID, pgvector included.
- With the `com.apple.security.cs.disable-library-validation` entitlement, initdb ran and
  `CREATE EXTENSION vector` worked (distance 1).
- Gatekeeper rejected the ad hoc build, as expected. `syspolicy_check` flagged "Adhoc Signed App",
  "Bad Load Command" and "Notary Ticket Missing".

### App layout

Laid out as a proper app, the bundle passes everything a Developer ID does not fix (mac-06):

- Programs and libraries sit in `Contents/Helpers` (58 MB, Mach-O files only). Postgres's data files
  sit in `Contents/Resources` (4 MB).
- `codesign --verify --strict --deep` passed.
- `syspolicy_check` reported only "Adhoc Signed App" and "Notary Ticket Missing".
- pgvector loaded inside the app with library validation relaxed.

Signed with one Developer ID, every file shares one Team ID, so library validation should pass
without the entitlement. That is the expected path, and it is untested. The entitlement is the
proven fallback.

### Left on the test Mac

The bundle and scripts are still on the Mac in `~/moss-js37` (72 MB). To try identity signing with
your own certificate, run this in Terminal on the Mac, not over SSH:

```
bash ~/moss-js37/scripts/sign.sh identity
```

Then remove the folder:

```
rm -rf ~/moss-js37
```

Nothing else was left behind. The eight test crash reports were deleted.

## Windows approach (untested)

Nothing ran on Windows. This is the plan, built on patterns herdr-core already uses on Windows.

### Install

- A per-user installer, so no admin rights.
- Programs in `%LOCALAPPDATA%\Programs\Moss`. Data in `%LOCALAPPDATA%\Moss\`, with a protected ACL
  that admits only the user and SYSTEM.
- Start at login only when the owner turns it on, through the per-user Run key or a per-user
  scheduled task.

### Running Postgres

- Postgres runs as a child of the supervisor, not as a service, because installing a service needs
  admin.
- Start it suspended and windowless, put it in a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resume it. When the supervisor dies, Windows ends every
  database process. herdr-core does the same (`windows_exec.rs`).
- `TerminateJobObject` also clears leftover backends after a postmaster crash.
- Stop with `pg_ctl kill INT <pid>`, which uses Postgres's own signal pipe. The job object is the
  backstop.
- postgres.exe refuses to run with admin rights. Start it with a restricted token, as `pg_ctl`
  does, or refuse to run elevated.

### Connections and the runner handshake

- Postgres listens on a Unix-domain socket in the private folder, guarded by the folder's ACL. It
  supports this on Windows 10 1803 and later.
- If the socket fails, fall back to loopback TCP on a free port, with SCRAM.
- The runner handshake uses a named pipe, set up as herdr-core does it (`windows.rs`):
  - `FILE_FLAG_FIRST_PIPE_INSTANCE`, so no other program can create the pipe first
  - `PIPE_REJECT_REMOTE_CLIENTS`
  - the security descriptor `D:P(A;;GA;;;SY)(A;;GA;;;<user SID>)S:(ML;;NRNW;;;ME)`, raised to high
    integrity when elevated
  - both ends check each other with `GetNamedPipeClientProcessId` and `GetNamedPipeServerProcessId`
  - a random token passed through an inherited handle, never in the environment or arguments

### Crash dumps

- Postgres writes minidumps to a `crashdumps` folder in the data folder, but only if that folder
  exists. Never create it.
- `WerAddExcludedApplication(L"postgres.exe", FALSE)` stops Windows Error Reporting for this user
  and needs no admin.
- The add-on could also call `WerSetFlags` to keep heap memory out of any report.
- LocalDumps settings live in a machine-wide registry key that needs admin, so they are out.
- What `SEM_NOGPFAULTERRORBOX` changes is unknown.

### Disk encryption

- Read the Shell property `System.Volume.BitLockerProtection`, which needs no admin. `manage-bde`
  does need admin. The meaning of each value must be checked on a real machine.
- Check the system drive too, because the page file, hibernation file and crash reports live there.
- Other encryption products are not detected. Report unknown and say so.

### Other risks

- Defender scanning can slow Postgres and lock its files. Exclusions need admin, and the rules
  forbid asking for them, so the supervisor retries a bounded number of times.
- User folders with non-ASCII names are a known Postgres risk on Windows. Test them.
- Build Postgres with meson and MSVC, and pgvector with `nmake /F Makefile.win`. Sign every exe and
  dll.

## Bundling

Build Postgres, pgvector and the add-on ourselves in CI from the official, checksum-checked source,
then sign the result. The reasons:

- A signed Mac app keeps code and data files in separate folders. Our own build controls that
  layout, as the app layout above shows.
- We must set the oldest supported macOS. This bundle needs macOS 26.0 because it linked
  Homebrew's libraries. A CI build sets the deployment target.
- We must set the oldest supported Linux. This build needs glibc 2.38. Building on the oldest
  supported base fixes that.
- `moss_nodump` and pgvector must compile against the exact Postgres headers.
- Every Mac and Windows binary gets re-signed anyway, so a ready-made build saves little.
- Fewer outside parties sit in the supply chain.

Ready-made builds were considered and not downloaded or tried:

| Source                         | Why not                                                   |
| ------------------------------ | --------------------------------------------------------- |
| Distro packages                | Need root and are not relocatable                         |
| EDB zip binaries               | Would still need our add-on, our layout and our signature |
| Postgres.app                   | Same                                                      |
| zonky embedded binaries        | No pgvector                                               |
| theseus-rs postgresql-binaries | No pgvector                                               |

### Build

- Postgres from https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2, sha256
  `dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979`, which matches the published
  `.sha256` file.
- pgvector from https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz, sha256
  `cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85`.
- Configure flags are `--without-readline --with-icu --with-zstd --without-openssl`. SCRAM works
  without OpenSSL, and SSL is off because nothing listens on the network.
- The Linux build tools (bison, flex, m4) came from Ubuntu 24.04's packages, unpacked into the
  scratch folder and not installed.

### Size

| Platform     | Measure                                      | Size   |
| ------------ | -------------------------------------------- | ------ |
| Linux x86_64 | Full install                                 | 35 MB  |
| Linux x86_64 | Runtime files, stripped                      | 23 MB  |
| Linux x86_64 | Desktop programs only                        | 11 MB  |
| Linux x86_64 | System libraries it uses (ICU 35 MB of this) | 39 MB  |
| macOS arm64  | App, including ICU (37 MB)                   | 62 MB  |
| macOS arm64  | App after `strip -x`                         | 56 MB  |
| macOS arm64  | Desktop programs only                        | 9.6 MB |
| Both         | pgvector                                     | 216 KB |

- The desktop programs are postgres, initdb, pg_ctl, psql, pg_dump and pg_restore.
- On Linux, bundle ICU and zstd. libstdc++ and libgcc_s can come from the system when the build
  runs on the oldest supported base.
- ICU data could be trimmed to the locales Moss needs (untested).
- Postgres 17's builtin C.UTF-8 provider would drop ICU entirely, but it sorts differently. ICU's
  root collation sorts the same on Linux and macOS.

### Licences

| Part                             | Licence                                      |
| -------------------------------- | -------------------------------------------- |
| Postgres, pgvector               | PostgreSQL Licence                           |
| ICU                              | Unicode License v3                           |
| zstd                             | BSD-3-Clause                                 |
| zlib                             | zlib licence                                 |
| libstdc++, libgcc_s (if bundled) | GPLv3 with the GCC Runtime Library Exception |

All of them allow shipping inside the app, with their notices in the app's licence list. The GCC
runtime libraries rely on the GCC Runtime Library Exception. The Linux plan avoids bundling them by
building on the oldest supported base.

## Tested matrix

| OS                                       | CPU    | Account                                  | What ran                               |
| ---------------------------------------- | ------ | ---------------------------------------- | -------------------------------------- |
| Ubuntu 24.04 LTS, kernel 6.8, glibc 2.39 | x86_64 | In the admin group; no admin rights used | `moss-db`, every flow above            |
| macOS 26.5.2                             | arm64  | In the admin group; no admin rights used | The same flows by hand; ad hoc signing |
| Windows                                  | none   | none                                     | Nothing                                |

No standard (non-admin) account was tried on any OS.

## Rules covered

| Rule                                                              | Status                                             |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| A local-only cluster with generated credentials                   | Done. Socket only, generated passwords, SCRAM      |
| Never attach to or kill an unrelated Postgres                     | Done. Logs 04b, 17-18 and 31                       |
| Publish a tested OS, CPU and distro matrix                        | Started above. Phase 7 owns the full matrix        |
| Setup resumes after a power cut                                   | Done for database setup. Log 22                    |
| Start at login is an explicit choice                              | Not built. The Windows plan covers it              |
| No antivirus exclusion; bounded retry                             | In the Windows plan. Untested                      |
| Cover swap and crash dumps; show verified, unavailable or unknown | Done on Linux. The Mac checks were matched by hand |
| A practical graphical route to protection on the supported matrix | Not proven. See below                              |

`moss-db` says "off" where the rules say "unavailable". Phase 7 should pick one word for the
installer.

## Not proven

- Notarization with a Developer ID, and a Gatekeeper launch of a quarantined download.
- Library validation passing without the entitlement when every file shares one Team ID.
- `moss-db` compiled or run on a Mac. Its Mac code only type-checks, and its disk-encryption
  checks were matched by hand.
- Intel Macs and macOS older than 26.
- Windows, entirely.
- A standard (non-admin) account on any OS.
- A Linux build on an older glibc with ICU bundled, and any distro other than Ubuntu 24.04.
- The `/dev/shm` verdict, which stays unknown.
- Mac crash reports hold register values and stack addresses, which can carry small fragments of
  data. What Apple receives when the user shares analytics was not checked.
- A practical graphical route to disk encryption. On Linux, encryption is usually chosen when the
  OS is installed, and no graphical route for an existing disk was tested. If none is found, the
  rules make a separately specified, tested encrypted-storage feature a release gate.
- Keys unlocking and recovering in a real install (the plan's Phase 1 keys bullet). Outside this
  task.
- The two JavaScript backfills on a database with rows. Only their empty-table effect is ported.
- clippy and rustfmt. Neither is in the minimal Rust install, and nothing was added.

## How to proceed

### Linux

- Build in CI on the oldest supported base, bundle ICU and zstd, and keep the relative library path.
- Rerun `proof/linux/` on each distro in the matrix.
- Keep `moss_nodump` in the bundle, because the crash-dump check depends on it.
- Decide the graphical encryption route, or write the encrypted-storage spec that the rules make a
  release gate.

### macOS

- Get the Developer ID (plan decision 7.6).
- Build in CI with the deployment target set to the oldest supported macOS, for arm64 and also
  x86_64 if Intel is supported.
- Sign every file with one Team ID and the hardened runtime, then notarize and staple.
- On a clean Mac, launch a quarantined download and run `CREATE EXTENSION vector`. Try it first
  without the library-validation entitlement, and keep the entitlement only if that fails.
- Run `moss-db` itself on a Mac.

### Windows

- Get a Windows 11 machine with a standard account.
- Build Postgres with meson and MSVC, and pgvector with nmake.
- Prove the steps in this order:
  1. Postgres runs as the user from the private folder.
  2. The job object ends it when the supervisor dies.
  3. The named-pipe handshake.
  4. The crash-report exclusion.
  5. The BitLocker reading.
- If Postgres cannot run as a normal user, the kill gate fires. Windows installs then become thin
  clients to an install on another machine, and the plan is re-cut before Phase 7.

### Every OS

- Port the two JavaScript backfills before moving an existing Docker install.
- Run the rules doc's G1 gate on fresh standard-user machines for every declared OS and CPU.

## Tools not available

- Rust on the Mac. Not installed, per the brief.
- Identity signing over SSH, because the keychain stays locked.
- clippy and rustfmt. Not added, per the no-install rule.
- bison, flex and m4 on the Linux machine. Unpacked from Ubuntu's packages into the scratch folder
  instead.
