//! The app's migrations, run the way `scripts/migrate.ts` runs them, minus pg-boss.
//!
//! Order: bootstrap SQL as the superuser under the cluster DDL lock, then role passwords, then
//! every core and built-in module folder as `jarvis_migration_owner` with the same checksum
//! table, transactions, legacy shims and lock as `runSqlMigrations`. pg-boss and its grants are
//! skipped: the Rust app will not use the Node job queue.

use std::path::Path;

use portability::migrations::{assert_unique_versions, load_migration_files, MigrationFile};
use sha2::{Digest, Sha256};

use crate::cluster::{db_error, Endpoint};
use crate::layout::Layout;
use crate::secrets::{self, Secret};
use crate::{APP_DATABASE, RUNTIME_ROLES, SUPERUSER};

/// Core first, then built-in modules in registry order (`getBuiltInSqlMigrationDirectories`).
pub const FOLDERS: [&str; 27] = [
    "infra/postgres/migrations",
    "packages/settings/sql",
    "packages/connectors/sql",
    "packages/tasks/sql",
    "packages/goals/sql",
    "packages/integrations/sql",
    "packages/notifications/sql",
    "packages/calendar/sql",
    "packages/email/sql",
    "packages/ai/sql",
    "packages/chat/sql",
    "packages/briefings/sql",
    "packages/memory/sql",
    "packages/usefulness-feedback/sql",
    "packages/structured-state/sql",
    "packages/wellness/sql",
    "packages/sports/sql",
    "packages/news/sql",
    "packages/notes/sql",
    "packages/meetings/sql",
    "packages/scratchpad/sql",
    "packages/proactive-monitoring/src/sql",
    "packages/commitments/sql",
    "packages/people/sql",
    "packages/workflows/sql",
    "packages/workshop/sql",
    "packages/backtrack/sql",
];

const BOOTSTRAP: &str = "infra/postgres/bootstrap";
const CLUSTER_DDL_LOCK: &str = "SELECT pg_advisory_lock(hashtext('jarv1s:cluster-ddl'))";
const CLUSTER_DDL_UNLOCK: &str = "SELECT pg_advisory_unlock(hashtext('jarv1s:cluster-ddl'))";
const MIGRATIONS_LOCK: &str = "SELECT pg_advisory_lock(hashtext('jarv1s:migrations'))";
const MIGRATIONS_UNLOCK: &str = "SELECT pg_advisory_unlock(hashtext('jarv1s:migrations'))";

/// `LEGACY_UPGRADE_SHIMS` in `packages/db/src/migrations/legacy-upgrade-shims.ts`.
struct Shim {
    name: &'static str,
    checksum: &'static str,
    relax_forced_rls: &'static [&'static str],
    before: &'static [&'static str],
}

const SHIMS: [Shim; 3] = [
    Shim {
        name: "0191_sports_public_source_runtime.sql",
        checksum: "9c54be2ac548c2b3e39a68ffe9aa3d6c175e9978dedae1bbef554607bbc37e6b",
        relax_forced_rls: &["app.sports_custom_sources", "app.sports_source_assignments"],
        before: &[],
    },
    Shim {
        name: "0204_news_source_health_states.sql",
        checksum: "3f2a7f2ab458bab2d568ef202e92960cb6574cbe3a857fbb91194b09717c0053",
        relax_forced_rls: &["app.news_custom_sources"],
        before: &["DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
            WHERE conrelid = 'app.news_custom_sources'::regclass
              AND conname = 'news_custom_sources_health_status_check'
              AND pg_get_constraintdef(oid) LIKE '%''available''%'
         ) THEN
           ALTER TABLE app.news_custom_sources DROP CONSTRAINT news_custom_sources_health_status_check;
         END IF;
       END
       $$"],
    },
    Shim {
        name: "0218_news_source_kinds.sql",
        checksum: "2f4ce7bf4ba1ce322109652ec4fb517b934ec032fff9632c1d73f2419f8c79ec",
        relax_forced_rls: &["app.news_custom_sources"],
        before: &[],
    },
];

/// A JavaScript backfill's effect on a database where the tables it reads are empty. Its loops
/// then find no rows, so only its trailing statements change anything. Pinned to the exact
/// file bytes; any other version, or a table with rows, stops the migration.
struct EmptyBackfill {
    sidecar: &'static str,
    sha256: &'static str,
    reads: &'static [&'static str],
    statements: &'static [&'static str],
}

const EMPTY_BACKFILLS: [EmptyBackfill; 2] = [
    EmptyBackfill {
        sidecar: "0280_meeting_history.backfill.mjs",
        sha256: "2b050f666100048a645c10ea9047a4cec35fd47528f97bdd5a45b6bf99679f0e",
        reads: &[
            "app.meeting_records",
            "app.meeting_transcript_batches",
            "app.meeting_output_requests",
            "app.meeting_output_artifacts",
            "app.meeting_export_receipts",
        ],
        statements: &[
            "ALTER TABLE app.meeting_records FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_transcript_batches FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_history_segments FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_output_requests FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_output_artifacts FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_export_receipts FORCE ROW LEVEL SECURITY",
        ],
    },
    EmptyBackfill {
        sidecar: "0292_meeting_minimal.backfill.mjs",
        sha256: "9f8bcc6fae4d48a163e60708db59e73260567d4b89d6bde81e65ec4884c44f22",
        reads: &["app.meeting_output_artifacts", "app.meeting_capture_grants"],
        statements: &[
            "ALTER TABLE app.meeting_output_artifacts DISABLE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_capture_grants DISABLE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_output_artifacts ENABLE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_output_artifacts FORCE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_capture_grants ENABLE ROW LEVEL SECURITY",
            "ALTER TABLE app.meeting_capture_grants FORCE ROW LEVEL SECURITY",
        ],
    },
];

#[derive(Debug, Default)]
pub struct Summary {
    pub created_database: bool,
    pub bootstrap_files: usize,
    pub applied: usize,
    pub skipped: usize,
    pub backfills_on_empty_tables: Vec<String>,
}

/// Bootstrap, passwords and migrations, in the order `scripts/migrate.ts` uses.
pub fn run(repo: &Path, layout: &Layout, endpoint: &Endpoint) -> Result<Summary, String> {
    let superuser = secrets::password(layout, SUPERUSER).map_err(|e| e.to_string())?;
    let mut summary = Summary { created_database: ensure_database(endpoint, &superuser)?, ..Summary::default() };
    summary.bootstrap_files = bootstrap(repo, layout, endpoint, &superuser)?;
    let owner = secrets::password(layout, "jarvis_migration_owner").map_err(|e| e.to_string())?;
    migrate(repo, endpoint, &owner, &mut summary)?;
    Ok(summary)
}

fn ensure_database(endpoint: &Endpoint, superuser: &Secret) -> Result<bool, String> {
    let mut client = endpoint.connect(SUPERUSER, superuser, "postgres")?;
    let exists = client
        .query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&APP_DATABASE])
        .map_err(|e| db_error(&e))?
        .is_some();
    if !exists {
        client.batch_execute(&format!("CREATE DATABASE {}", quote_ident(APP_DATABASE))).map_err(|e| db_error(&e))?;
    }
    Ok(!exists)
}

/// `runSqlFilesWithClient` on the bootstrap folder and `applyRolePasswords`, both under the
/// cluster DDL lock. The lock lives on the maintenance database, the DDL runs on the app's.
fn bootstrap(repo: &Path, layout: &Layout, endpoint: &Endpoint, superuser: &Secret) -> Result<usize, String> {
    let mut lock = endpoint.connect(SUPERUSER, superuser, "postgres")?;
    lock.batch_execute(CLUSTER_DDL_LOCK).map_err(|e| db_error(&e))?;
    let mut ddl = endpoint.connect(SUPERUSER, superuser, APP_DATABASE)?;

    let folder = repo.join(BOOTSTRAP);
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .map_err(|e| format!("{}: {e}", folder.display()))?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    for name in &names {
        let sql = std::fs::read_to_string(folder.join(name)).map_err(|e| format!("{name}: {e}"))?;
        let mut tx = ddl.transaction().map_err(|e| db_error(&e))?;
        tx.batch_execute(&sql).map_err(|e| format!("{name}: {}", db_error(&e)))?;
        tx.commit().map_err(|e| db_error(&e))?;
    }

    // The verifier is computed here, so the plain password never reaches the server or its log.
    for role in RUNTIME_ROLES {
        let password = secrets::password(layout, role).map_err(|e| e.to_string())?;
        let verifier = postgres_protocol::password::scram_sha_256(password.expose().as_bytes());
        if verifier.contains('\'') {
            return Err("unexpected character in a password verifier".into());
        }
        ddl.batch_execute(&format!("ALTER ROLE {} WITH LOGIN PASSWORD '{verifier}'", quote_ident(role)))
            .map_err(|e| format!("password for {role}: {}", db_error(&e)))?;
    }
    lock.batch_execute(CLUSTER_DDL_UNLOCK).map_err(|e| db_error(&e))?;
    Ok(names.len())
}

fn migrate(repo: &Path, endpoint: &Endpoint, owner: &Secret, summary: &mut Summary) -> Result<(), String> {
    let mut folders = Vec::new();
    for folder in FOLDERS {
        folders.push((folder, load_migration_files(&repo.join(folder))?));
    }
    let mut all: Vec<MigrationFile> = folders.iter().flat_map(|(_, files)| files.iter().cloned()).collect();
    all.extend(package_migration_reservations(repo)?);
    assert_unique_versions(&all)?;

    let mut client = endpoint.connect("jarvis_migration_owner", owner, APP_DATABASE)?;
    client.batch_execute(MIGRATIONS_LOCK).map_err(|e| db_error(&e))?;
    client
        .batch_execute(
            r#"CREATE SCHEMA IF NOT EXISTS "app" AUTHORIZATION CURRENT_USER;
               CREATE TABLE IF NOT EXISTS "app"."schema_migrations" (
                 version text PRIMARY KEY,
                 name text NOT NULL,
                 checksum text NOT NULL,
                 applied_at timestamptz NOT NULL DEFAULT now()
               )"#,
        )
        .map_err(|e| db_error(&e))?;

    for (folder, files) in &folders {
        let dir = repo.join(folder);
        for file in files {
            let existing = client
                .query_opt(r#"SELECT checksum FROM "app"."schema_migrations" WHERE version = $1"#, &[&file.version])
                .map_err(|e| db_error(&e))?;
            if let Some(row) = existing {
                if row.get::<_, String>(0) != file.checksum {
                    return Err(format!("Migration {} has changed after being applied", file.name));
                }
                summary.skipped += 1;
                continue;
            }
            let sql = read_unchanged(&dir, file)?;
            let mut tx = client.transaction().map_err(|e| db_error(&e))?;
            let shim = SHIMS.iter().find(|shim| shim.name == file.name && shim.checksum == file.checksum);
            let mut restore = Vec::new();
            if let Some(shim) = shim {
                for table in shim.relax_forced_rls {
                    let forced: bool = tx
                        .query_one("SELECT relforcerowsecurity FROM pg_class WHERE oid = ($1::text)::regclass", &[table])
                        .map_err(|e| db_error(&e))?
                        .get(0);
                    if forced {
                        tx.batch_execute(&format!("ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY"))
                            .map_err(|e| db_error(&e))?;
                        restore.push(*table);
                    }
                }
                for statement in shim.before {
                    tx.batch_execute(statement).map_err(|e| db_error(&e))?;
                }
            }
            tx.batch_execute(&sql).map_err(|e| format!("{}: {}", file.name, db_error(&e)))?;
            if let Some(sidecar) = &file.backfill {
                empty_backfill(&mut tx, &dir, sidecar)?;
                summary.backfills_on_empty_tables.push(sidecar.clone());
            }
            for table in restore {
                tx.batch_execute(&format!("ALTER TABLE {table} FORCE ROW LEVEL SECURITY")).map_err(|e| db_error(&e))?;
            }
            tx.execute(
                r#"INSERT INTO "app"."schema_migrations" (version, name, checksum) VALUES ($1, $2, $3)"#,
                &[&file.version, &file.name, &file.checksum],
            )
            .map_err(|e| db_error(&e))?;
            tx.commit().map_err(|e| db_error(&e))?;
            summary.applied += 1;
        }
    }
    client.batch_execute(MIGRATIONS_UNLOCK).map_err(|e| db_error(&e))?;
    Ok(())
}

/// The file's text, refused if its bytes changed since its checksum was taken.
fn read_unchanged(dir: &Path, file: &MigrationFile) -> Result<String, String> {
    let bytes = std::fs::read(dir.join(&file.name)).map_err(|e| format!("{}: {e}", file.name))?;
    if hex::encode(Sha256::digest(&bytes)) != file.old_rule_checksum {
        return Err(format!("Migration {} changed while migrating", file.name));
    }
    String::from_utf8(bytes).map_err(|_| format!("Migration file {} must contain valid UTF-8", file.name))
}

fn empty_backfill(tx: &mut postgres::Transaction<'_>, dir: &Path, sidecar: &str) -> Result<(), String> {
    let pinned = EMPTY_BACKFILLS
        .iter()
        .find(|backfill| backfill.sidecar == sidecar)
        .ok_or_else(|| format!("backfill {sidecar} has no Rust equivalent"))?;
    let bytes = std::fs::read(dir.join(sidecar)).map_err(|e| format!("{sidecar}: {e}"))?;
    if hex::encode(Sha256::digest(&bytes)) != pinned.sha256 {
        return Err(format!("backfill {sidecar} is not the version this spike was written for"));
    }
    for table in pinned.reads {
        // Under FORCE the owner sees no rows, so lift it to look, then put it back.
        let forced: bool = tx
            .query_one("SELECT relforcerowsecurity FROM pg_class WHERE oid = ($1::text)::regclass", &[table])
            .map_err(|e| db_error(&e))?
            .get(0);
        tx.batch_execute(&format!("ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")).map_err(|e| db_error(&e))?;
        let has_rows: bool = tx
            .query_one(&format!("SELECT EXISTS (SELECT 1 FROM {table})"), &[])
            .map_err(|e| db_error(&e))?
            .get(0);
        if forced {
            tx.batch_execute(&format!("ALTER TABLE {table} FORCE ROW LEVEL SECURITY")).map_err(|e| db_error(&e))?;
        }
        if has_rows {
            return Err(format!("{table} has rows, so backfill {sidecar} would change data; it is not ported"));
        }
    }
    for statement in pinned.statements {
        tx.batch_execute(statement).map_err(|e| format!("{sidecar}: {}", db_error(&e)))?;
    }
    Ok(())
}

/// Identifiers here are constants; anything outside `[a-z0-9_]` is refused.
fn quote_ident(name: &str) -> String {
    assert!(name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "unsafe identifier");
    format!("\"{name}\"")
}

/// Reserve package SQL versions; execution stays with the restricted installer.
fn package_migration_reservations(repo: &Path) -> Result<Vec<MigrationFile>, String> {
    let mut files = Vec::new();
    let entries = match std::fs::read_dir(repo.join("modules")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let sql = entry.path().join("sql");
        if sql.is_dir() {
            files.extend(load_migration_files(&sql)?);
        }
    }
    Ok(files)
}

#[cfg(test)]
mod reservation_tests {
    use super::*;

    #[test]
    fn package_sql_reserves_versions_without_entering_execution_folders() {
        let repo = tempfile::tempdir().unwrap();
        assert!(package_migration_reservations(repo.path()).unwrap().is_empty());
        let package = repo.path().join("modules/notes/sql");
        let core = repo.path().join("infra/postgres/migrations");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(package.join("0360_notes.sql"), "SELECT 1;").unwrap();
        std::fs::write(core.join("0360_collision.sql"), "SELECT 2;").unwrap();
        let mut files = load_migration_files(&core).unwrap();
        assert_unique_versions(&files).unwrap();
        files.extend(package_migration_reservations(repo.path()).unwrap());
        assert!(assert_unique_versions(&files).unwrap_err().contains("0360"));
        assert!(!FOLDERS.iter().any(|folder| folder.starts_with("modules/")));
    }
}
