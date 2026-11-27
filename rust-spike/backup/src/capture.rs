//! Taking one backup of an instance: database dump, files and manifest in one encrypted archive.

use std::io::{BufWriter, Write};
use std::path::Path;

use bundled_db::cluster::{self, Bundle, Endpoint};
use bundled_db::dump::{self, Target};
use bundled_db::layout::Layout;
use bundled_db::{secrets, APP_DATABASE, SUPERUSER};
use keystore::custody;
use postgres::GenericClient;
use serde_json::{json, Value};

use crate::archive::{self, ArchiveWriter, HashingWriter};
use crate::{fence, ledger, quote_ident};

/// What a finished backup wrote.
pub struct Captured {
    pub id: String,
    pub size: u64,
    pub sha256: String,
}

pub(crate) const TABLES: &str = "SELECT n.nspname, c.relname, c.relkind::text \
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' \
    ORDER BY 1, 2";

/// Row counts of every app table, keyed `schema.table`. Partitioned parents are left out, since
/// their rows are counted in their partitions.
pub(crate) fn row_counts(client: &mut impl GenericClient) -> Result<(Vec<String>, Value), String> {
    let rows = client
        .query(TABLES, &[])
        .map_err(|e| cluster::db_error(&e))?;
    let mut all = Vec::new();
    let mut counts = serde_json::Map::new();
    for row in rows {
        let (schema, table, kind): (String, String, String) = (row.get(0), row.get(1), row.get(2));
        let qualified = format!("{}.{}", quote_ident(&schema), quote_ident(&table));
        all.push(qualified.clone());
        if kind == "r" {
            let count: i64 = client
                .query_one(&format!("SELECT count(*) FROM ONLY {qualified}"), &[])
                .map_err(|e| cluster::db_error(&e))?
                .get(0);
            counts.insert(format!("{schema}.{table}"), json!(count));
        }
    }
    Ok((all, Value::Object(counts)))
}

/// The cluster roles the dump refers to, without system roles and the superuser itself.
fn roles(client: &mut impl GenericClient) -> Result<Value, String> {
    let list = client
        .query(
            "SELECT rolname, rolinherit, rolcreaterole, rolcreatedb FROM pg_roles \
             WHERE rolname !~ '^pg_' AND rolname <> current_user ORDER BY 1",
            &[],
        )
        .map_err(|e| cluster::db_error(&e))?
        .iter()
        .map(|r| {
            json!({
                "name": r.get::<_, String>(0),
                "inherit": r.get::<_, bool>(1),
                "createRole": r.get::<_, bool>(2),
                "createDb": r.get::<_, bool>(3),
            })
        })
        .collect::<Vec<_>>();
    let members = client
        .query(
            "SELECT g.rolname, m.rolname, a.admin_option FROM pg_auth_members a \
             JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member \
             WHERE m.rolname !~ '^pg_' AND m.rolname <> current_user \
               AND g.rolname <> current_user ORDER BY 1, 2",
            &[],
        )
        .map_err(|e| cluster::db_error(&e))?
        .iter()
        .map(|r| {
            json!({
                "role": r.get::<_, String>(0),
                "member": r.get::<_, String>(1),
                "admin": r.get::<_, bool>(2),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "roles": list, "memberships": members }))
}

/// Backs up a running instance into `backups/<id>.mossbak` and records it, unverified.
pub fn backup(instance: &Path, bundle: &Bundle, pause: Option<&Path>) -> Result<Captured, String> {
    let instance = instance
        .canonicalize()
        .map_err(|e| format!("{}: {e}", instance.display()))?;
    if instance.join(custody::LEGACY_CREDENTIALS).exists() {
        return Err(
            "this instance still has a plain credentials file; finish key custody first".into(),
        );
    }
    let key_bundle = custody::read_bundle(&instance).map_err(|e| e.to_string())?;
    let master =
        keystore::database_secrets::instance_master(&instance).map_err(|e| e.to_string())?;
    // An archive whose key bundle this master key cannot open could never be restored.
    custody::unwrap_with_master(&key_bundle, &master).map_err(|e| e.to_string())?;

    let layout = Layout::open(&crate::database_root(&instance)).map_err(|e| e.to_string())?;
    let state = cluster::read_state(&layout)?;
    let endpoint = Endpoint::from_json(&state["endpoint"], &layout.run)
        .ok_or("the database is not running")?;
    let password = secrets::existing(&layout, SUPERUSER)?;

    let dir = crate::backups_dir(&instance);
    crate::create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let created_at = crate::now_seconds();
    let id = crate::new_backup_id(created_at);
    let partial = dir.join(format!("{id}.partial"));
    let file =
        crate::create_private_file(&partial).map_err(|e| format!("{}: {e}", partial.display()))?;
    let written = (|| {
        let out = HashingWriter::new(BufWriter::new(file));
        let mut writer = ArchiveWriter::new(out, &id, created_at, &master, &key_bundle)
            .map_err(|e| format!("archive: {e}"))?;
        let manifest = capture(
            &instance,
            &layout,
            bundle,
            &endpoint,
            &password,
            &mut writer,
            pause,
        )?;
        let mut out = finish(writer, &id, created_at, manifest)?;
        out.flush().map_err(|e| format!("archive: {e}"))?;
        let digest = out.digest();
        let size = out.bytes;
        let file = out
            .inner
            .into_inner()
            .map_err(|e| format!("archive: {e}"))?;
        file.sync_all().map_err(|e| format!("archive: {e}"))?;
        Ok::<_, String>((size, digest))
    })();
    let (size, sha256) = match written {
        Ok(done) => done,
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    };
    let path = ledger::archive_path(&instance, &id);
    std::fs::rename(&partial, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    ledger::update(&instance, |entries| {
        entries.push(ledger::Entry {
            id: id.clone(),
            created_at,
            size,
            sha256: sha256.clone(),
            verified: false,
            verified_at: None,
            pinned: false,
        });
        Ok(())
    })?;
    Ok(Captured { id, size, sha256 })
}

/// Writes the roles, the dump and the files with the fence held, and returns the manifest.
fn capture<W: Write>(
    instance: &Path,
    layout: &Layout,
    bundle: &Bundle,
    endpoint: &Endpoint,
    password: &secrets::Secret,
    writer: &mut ArchiveWriter<W>,
    pause: Option<&Path>,
) -> Result<Value, String> {
    let _fence = fence::exclusive(instance).map_err(|e| format!("write fence: {e}"))?;
    let mut client = endpoint.connect(SUPERUSER, password, APP_DATABASE)?;
    let mut fenced = client.transaction().map_err(|e| cluster::db_error(&e))?;
    fenced
        .batch_execute("SET LOCAL lock_timeout = '30s'")
        .map_err(|e| cluster::db_error(&e))?;
    let (tables, _) = row_counts(&mut fenced)?;
    if !tables.is_empty() {
        fenced
            .batch_execute(&format!("LOCK TABLE {} IN SHARE MODE", tables.join(", ")))
            .map_err(|e| {
                format!(
                    "hold the app tables for the backup: {}",
                    cluster::db_error(&e)
                )
            })?;
    }
    let (_, counts) = row_counts(&mut fenced)?;
    let owner: String = fenced
        .query_one(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()",
            &[],
        )
        .map_err(|e| cluster::db_error(&e))?
        .get(0);
    let roles = roles(&mut fenced)?;
    let roles_text = roles.to_string();
    writer
        .begin_entry(archive::ENTRY_ROLES, "roles.json")
        .map_err(|e| e.to_string())?;
    writer
        .segment(roles_text.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.end_entry().map_err(|e| e.to_string())?;

    writer
        .begin_entry(archive::ENTRY_DUMP, "database.dump")
        .map_err(|e| e.to_string())?;
    let (dump_bytes, dump_sha256) = {
        let mut content = HashingWriter::new(writer.content());
        let target = Target {
            layout,
            bundle,
            endpoint,
            role: SUPERUSER,
            password,
        };
        dump::dump(&target, APP_DATABASE, &mut content)?;
        content.flush().map_err(|e| e.to_string())?;
        (content.bytes, content.digest())
    };
    writer.end_entry().map_err(|e| e.to_string())?;

    if let Some(marker) = pause {
        crate::test_pause(marker, "backup-between-dump-and-files")?;
    }

    let (files, skipped) = crate::instance_files(instance)?;
    let mut listed = Vec::new();
    for file in files {
        writer
            .begin_entry(archive::ENTRY_FILE, &file.name)
            .map_err(|e| e.to_string())?;
        let mut source =
            std::fs::File::open(&file.path).map_err(|e| format!("{}: {e}", file.name))?;
        let (size, sha256) = {
            let mut content = writer.content();
            archive::copy_hashed(&mut source, &mut content)
                .map_err(|e| format!("{}: {e}", file.name))?
        };
        writer.end_entry().map_err(|e| e.to_string())?;
        listed.push(json!({ "path": file.name, "size": size, "sha256": sha256 }));
    }
    fenced.commit().map_err(|e| cluster::db_error(&e))?;
    Ok(json!({
        "database": {
            "name": APP_DATABASE,
            "owner": owner,
            "dumpBytes": dump_bytes,
            "dumpSha256": dump_sha256,
            "rowCounts": counts,
        },
        "rolesSha256": hex::encode(<sha2::Sha256 as sha2::Digest>::digest(roles_text.as_bytes())),
        "files": listed,
        "skipped": skipped,
    }))
}

fn finish<W: Write>(
    mut writer: ArchiveWriter<W>,
    id: &str,
    created_at: u64,
    mut manifest: Value,
) -> Result<W, String> {
    manifest["backupId"] = json!(id);
    manifest["createdAt"] = json!(created_at);
    let text = manifest.to_string();
    writer
        .begin_entry(archive::ENTRY_MANIFEST, "manifest.json")
        .map_err(|e| e.to_string())?;
    writer.segment(text.as_bytes()).map_err(|e| e.to_string())?;
    writer.end_entry().map_err(|e| e.to_string())?;
    writer
        .write_all(&[archive::ENTRY_END])
        .map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| format!("archive: {e}"))
}
