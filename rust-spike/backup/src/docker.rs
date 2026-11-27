//! Docker-host move capture. A failed export deliberately leaves the source fenced.
//! The fence receipt is durable before the first mutation; private inventory is inside MOSSBAK1.

use std::collections::BTreeSet;
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use keystore::{custody, recovery::RecoveryKey};
use serde_json::{json, Value};

use crate::archive::{self, ArchiveWriter};

pub struct Docker;

impl Docker {
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new("docker");
        cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
        cmd
    }

    pub fn output(&self, args: &[&str], operation: &str) -> Result<Vec<u8>, String> {
        let out = self
            .command(args)
            .output()
            .map_err(|_| format!("Docker is unavailable: {operation}"))?;
        if !out.status.success() {
            return Err(format!(
                "Docker could not {operation}. The source is not automatically restarted."
            ));
        }
        Ok(out.stdout)
    }

    fn inspect(&self, id: &str) -> Result<Value, String> {
        let bytes = self.output(
            &["inspect", "--type", "container", id],
            "inspect a source container",
        )?;
        let list: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Docker returned an unreadable container inventory")?;
        list.get(0)
            .cloned()
            .ok_or_else(|| "Docker returned no source container".into())
    }

    fn stream<T>(
        &self,
        args: &[&str],
        operation: &str,
        consume: impl FnOnce(&mut dyn Read) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut child = self
            .command(args)
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| format!("Docker is unavailable: {operation}"))?;
        let result = consume(child.stdout.as_mut().unwrap());
        if result.is_err() {
            let _ = child.kill();
        }
        let status = child
            .wait()
            .map_err(|_| format!("Could not wait for Docker to {operation}"))?;
        let value = result?;
        if !status.success() {
            return Err(format!(
                "Docker could not {operation}. The source remains fenced."
            ));
        }
        Ok(value)
    }

    // Password expansion occurs in the database container, not in host arguments or diagnostics.
    fn pg_args<'a>(&self, id: &'a str, db: &'a str, script: &'a str) -> Vec<&'a str> {
        vec![
            "exec",
            "-i",
            "--env",
            "PGOPTIONS=-c default_transaction_read_only=on",
            id,
            "sh",
            "-c",
            script,
            "moss-docker-export",
            db,
        ]
    }

    fn query(&self, id: &str, db: &str, query: &str) -> Result<Value, String> {
        let args = self.pg_args(id, db, "export PGPASSWORD=\"$POSTGRES_PASSWORD\"; exec psql --host=/var/run/postgresql -XAt --set ON_ERROR_STOP=1 --username=\"${POSTGRES_USER:-postgres}\" --dbname=\"$1\"");
        let mut child = self
            .command(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "Could not inspect the source database")?;
        let sent = child.stdin.take().unwrap().write_all(query.as_bytes());
        if sent.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|_| "Could not inspect the source database")?;
        if sent.is_err() || !output.status.success() {
            return Err("Could not read the source catalog. Check the database name, source schema and container credentials.".into());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "The source catalog returned an unreadable inventory".into())
    }
}

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("The export plan needs {key}"))
}

fn list<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    v[key]
        .as_array()
        .ok_or_else(|| format!("The export plan needs a {key} list"))
}

fn id(info: &Value) -> &str {
    info["Id"].as_str().unwrap_or("")
}

fn stopped(info: &Value) -> bool {
    info["State"]["Running"] == false
        && info["State"]["Restarting"] == false
        && info["HostConfig"]["RestartPolicy"]["Name"] == "no"
}

/// Checks live identities and restart policies, so an importer need not trust the saved receipt.
/// This checks Docker state only: an external supervisor must also stay disabled by the operator.
pub fn check_fence(receipt: &Value) -> Result<(), String> {
    if receipt["kind"] != "moss-docker-fence"
        || receipt["version"] != 1
        || receipt["stage"] != "fenced"
    {
        return Err("Not a supported Docker fence receipt".into());
    }
    let containers = list(receipt, "containers")?;
    if containers.len() < 2 {
        return Err("The source fence receipt has no complete container inventory".into());
    }
    let mut identities = BTreeSet::new();
    for container in containers {
        let identity = text(container, "id")?;
        if identity.len() != 64
            || !identity.bytes().all(|b| b.is_ascii_hexdigit())
            || !identities.insert(identity)
        {
            return Err("The fence receipt needs distinct full container identities".into());
        }
        let info = Docker.inspect(identity)?;
        if !stopped(&info) {
            return Err("The old source is not fenced: a container is running or its restart policy is not no.".into());
        }
    }
    Ok(())
}

fn receipt_write(path: &Path, receipt: &Value, first: bool) -> Result<(), String> {
    let tmp = path.with_extension("fence-writing");
    let dest = if first { path } else { &tmp };
    let mut file = crate::create_private_file(dest)
        .map_err(|_| "Cannot save the source fence receipt; choose a new output path")?;
    file.write_all(receipt.to_string().as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist the source fence receipt")?;
    if !first {
        std::fs::rename(&tmp, path).map_err(|_| "Cannot publish the source fence receipt")?;
    }
    #[cfg(unix)]
    std::fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .and_then(|d| d.sync_all())
    .map_err(|_| "Cannot persist the source fence directory")?;
    Ok(())
}

const CATALOG: &str = "SELECT json_build_object(
 'accountsCount', (SELECT count(*) FROM app.users),
 'schemaVersion', (SELECT max(version) FROM app.schema_migrations),
 'coreLedger', (SELECT coalesce(json_agg(t ORDER BY t.version), '[]') FROM app.schema_migrations t),
 'moduleLedger', (SELECT coalesce(json_agg(t ORDER BY t.module_id,t.version), '[]') FROM app.module_schema_migrations t),
 'modules', (SELECT coalesce(json_agg(t ORDER BY t.module_id), '[]') FROM app.module_installs t),
 'tables', (SELECT json_agg(json_build_object('schema',n.nspname,'table',c.relname) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'),
 'extensions', (SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
 'otherClients', (SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend'));
";

/// Runs only against explicitly selected Compose identities; all persistent mounts must be
/// classified. `show_words` is called once after the finished archive has reached disk.
pub fn export(
    plan: &Value,
    output: &Path,
    show_words: impl FnOnce(&RecoveryKey) -> Result<(), String>,
) -> Result<Value, String> {
    if !cfg!(target_os = "linux") {
        return Err("Docker move export runs on a Linux Docker host".into());
    }
    let project = text(plan, "project")?;
    let database = text(plan, "database")?;
    text(plan, "postgres")?;
    let writers = list(plan, "writers")?;
    if writers.is_empty() {
        return Err("List every app and worker container in writers".into());
    }
    if plan["externalSupervisorsDisabled"] != true {
        return Err("Disable external restart services and external vault writers, then confirm externalSupervisorsDisabled in the plan".into());
    }
    let mounts = list(plan, "mounts")?;
    for credential in list(plan, "credentialsNotCarried")? {
        text(credential, "kind")?;
        text(credential, "reason")?;
    }
    let mut inventory = Vec::new();
    let mut ids = BTreeSet::new();
    for name in writers.iter().chain(std::iter::once(&plan["postgres"])) {
        let name = name.as_str().ok_or("Container names must be strings")?;
        let mut info = Docker.inspect(name)?;
        if info["Config"]["Labels"]["com.docker.compose.project"] != project {
            return Err(
                "A selected container does not belong to the specified Compose project".into(),
            );
        }
        if !ids.insert(id(&info).to_owned()) {
            return Err("A source container is listed twice".into());
        }
        if info["HostConfig"]["AutoRemove"] == true || info["HostConfig"]["Privileged"] == true {
            return Err(
                "Auto-removed or privileged source containers need a separate migration rehearsal"
                    .into(),
            );
        }
        info["exportName"] = json!(name);
        inventory.push(info);
    }
    let db = inventory.last().unwrap();
    let db_id = id(db).to_owned();
    let all = Docker.output(
        &[
            "ps",
            "-aq",
            "--filter",
            &format!("label=com.docker.compose.project={project}"),
        ],
        "enumerate source writers",
    )?;
    for container in String::from_utf8_lossy(&all).lines() {
        let info = Docker.inspect(container)?;
        if !ids.contains(id(&info)) && !stopped(&info) {
            return Err("The Compose project has an unlisted running or restartable container; include every producer in writers".into());
        }
    }
    // Match each mount exactly once. Never infer that an unknown volume can be discarded.
    let mut used = BTreeSet::new();
    let mut prefixes = BTreeSet::new();
    for info in &inventory {
        for mount in list(info, "Mounts")? {
            let target = text(mount, "Destination")?;
            if id(info) == db_id {
                if target != "/var/lib/postgresql/data" {
                    return Err("The database has an unclassified persistent mount".into());
                }
                continue;
            }
            let found: Vec<_> = mounts
                .iter()
                .enumerate()
                .filter(|(_, m)| m["container"] == info["exportName"] && m["target"] == target)
                .collect();
            if found.len() != 1 {
                return Err("Every source mount needs exactly one disposition in mounts".into());
            }
            let (index, m) = found[0];
            used.insert(index);
            match text(m, "disposition")? {
                "transferred" | "preserved-inactive" => {
                    let prefix = text(m, "archive")?;
                    crate::safe_join(Path::new("."), prefix)
                        .map_err(|_| "A mount archive root is unsafe")?;
                    if !prefixes.insert(prefix.to_owned())
                        || prefixes.iter().any(|p| {
                            p != prefix
                                && (p.starts_with(&format!("{prefix}/"))
                                    || prefix.starts_with(&format!("{p}/")))
                        })
                    {
                        return Err(
                            "Mount archive roots must be distinct and cannot overlap".into()
                        );
                    }
                    if m["disposition"] == "preserved-inactive" {
                        text(m, "reason")?;
                    }
                }
                "reconstructed" => {
                    text(m, "reason")?;
                }
                _ => return Err("Unknown mount disposition; nothing may be ignored".into()),
            }
        }
    }
    if used.len() != mounts.len() {
        return Err("The plan contains a mount not found on the source".into());
    }
    let receipt_path = output.with_extension("fence.json");
    let mut receipt = json!({"kind":"moss-docker-fence","version":1,"createdAt":crate::now_seconds(),"stage":"fencing","containers":inventory.iter().map(|i| json!({"id":id(i),"restartBefore":i["HostConfig"]["RestartPolicy"],"networksBefore":i["NetworkSettings"]["Networks"].as_object().map(|o|o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()})).collect::<Vec<_>>()});
    // Reserve both files before changing the source. No plaintext dump or copied vault on disk.
    let file = crate::create_private_file(output)
        .map_err(|_| "Choose a new archive path in an existing private directory")?;
    if let Err(e) = receipt_write(&receipt_path, &receipt, true) {
        let _ = std::fs::remove_file(output);
        return Err(e);
    }
    let result = (|| {
        // Change ALL policies before stopping ANY writer, including the DB for a failed cutover.
        for info in &inventory {
            Docker.output(
                &["update", "--restart=no", id(info)],
                "turn off a source container restart policy",
            )?;
            if Docker.inspect(id(info))?["HostConfig"]["RestartPolicy"]["Name"] != "no" {
                return Err(
                    "Cannot fence the source: a container restart policy did not change to no"
                        .into(),
                );
            }
        }
        for info in &inventory[..inventory.len() - 1] {
            Docker.output(
                &["stop", "--time", "30", id(info)],
                "stop a source app or worker container",
            )?;
            if !stopped(&Docker.inspect(id(info))?) {
                return Err("Cannot fence the source: an app or worker did not stop".into());
            }
        }
        // Remove network access while leaving the database's local socket for read-only pg_dump.
        if let Some(networks) = db["NetworkSettings"]["Networks"].as_object() {
            for name in networks.keys() {
                if name != "none" && name != "host" {
                    Docker.output(
                        &["network", "disconnect", name, &db_id],
                        "disconnect source database clients",
                    )?;
                } else if name == "host" {
                    return Err("A host-network database cannot be fenced by this exporter".into());
                }
            }
        }
        let catalog = Docker.query(&db_id, database, CATALOG)?;
        if catalog["otherClients"] != 0 {
            return Err("Cannot fence the source: database clients are still connected. Stop them before retrying.".into());
        }
        let recovery = RecoveryKey::generate();
        let master = custody::MasterKey::generate();
        // Full environment retains both keyrings, retired key ordering and session/signing config.
        // Nested family keys stay in the database. OS-bound sessions are preserved but inactive.
        let credentials = json!({"kind":"moss-docker-credentials","version":1,"containers":inventory.iter().map(|i|json!({"id":id(i),"environment":i["Config"]["Env"]})).collect::<Vec<_>>()});
        let bundle = custody::wrap_bundle(&master, &recovery, credentials.to_string().as_bytes());
        let created_at = crate::now_seconds();
        let backup_id = crate::new_backup_id(created_at);
        let mut writer = ArchiveWriter::new(
            BufWriter::new(file),
            &backup_id,
            created_at,
            &master,
            &bundle,
        )
        .map_err(|_| "Cannot start the encrypted archive")?;
        let roles = stream_entry(&mut writer, archive::ENTRY_ROLES, "roles.sql", &Docker.pg_args(&db_id, database, "export PGPASSWORD=\"$POSTGRES_PASSWORD\"; exec pg_dumpall --host=/var/run/postgresql --roles-only --username=\"${POSTGRES_USER:-postgres}\""))?;
        let dump = stream_entry(&mut writer, archive::ENTRY_DUMP, "database.dump", &Docker.pg_args(&db_id, database, "export PGPASSWORD=\"$POSTGRES_PASSWORD\"; exec pg_dump --host=/var/run/postgresql --format=custom --username=\"${POSTGRES_USER:-postgres}\" --dbname=\"$1\""))?;
        Docker.output(
            &["stop", "--time", "30", &db_id],
            "stop the source database after its dump",
        )?;
        receipt["stage"] = json!("fenced");
        check_fence(&receipt)?;
        receipt_write(&receipt_path, &receipt, false)?;
        let mut files = Vec::new();
        for m in mounts {
            if m["disposition"] == "reconstructed" {
                continue;
            }
            let container = inventory
                .iter()
                .find(|i| i["exportName"] == m["container"])
                .unwrap();
            capture_mount(
                &mut writer,
                id(container),
                text(m, "target")?,
                text(m, "archive")?,
                &mut files,
            )?;
        }
        let versions: Vec<_> = inventory[..inventory.len() - 1]
            .iter()
            .map(|i| {
                let version = i["Config"]["Env"].as_array().and_then(|env| {
                    env.iter().filter_map(Value::as_str).find_map(|e| {
                        e.strip_prefix("JARVIS_APP_VERSION=").filter(|v| !v.is_empty())
                    })
                });
                json!({"id":id(i),"image":i["Config"]["Image"],"imageId":i["Image"],
                    "version":version.unwrap_or(i["Config"]["Image"].as_str().unwrap_or("")),
                    "versionSource":if version.is_some() { "app-environment" } else { "image-reference" }})
            })
            .collect();
        let manifest = json!({"kind":"moss-docker-move","version":1,"backupId":backup_id,"createdAt":created_at,"mossVersion":versions,"schemaVersion":catalog["schemaVersion"],"accountsCount":catalog["accountsCount"],"modules":catalog["modules"],"catalog":catalog,"database":{"name":database,"dump":dump,"roles":roles},"files":files,"mounts":mounts,"sourceFence":receipt,"credentialsNotCarried":plan["credentialsNotCarried"],"credentialPortability":{"providerAcceptance":"not checked","osBoundSessions":"preserved but inactive; sign-in may be required"},"sourceInventory":inventory.iter().map(|i|json!({"id":id(i),"mounts":i["Mounts"]})).collect::<Vec<_>>()});
        writer
            .begin_entry(archive::ENTRY_MANIFEST, "manifest.json")
            .and_then(|_| writer.segment(manifest.to_string().as_bytes()))
            .and_then(|_| writer.end_entry())
            .and_then(|_| writer.write_all(&[archive::ENTRY_END]))
            .map_err(|_| "Cannot write the move manifest")?;
        let mut out = writer
            .finish()
            .map_err(|_| "Cannot finish the encrypted archive")?;
        out.flush()
            .and_then(|_| out.get_ref().sync_all())
            .map_err(|_| "Cannot persist the encrypted archive")?;
        check_fence(&receipt)?;
        show_words(&recovery)?;
        Ok(
            json!({"backupId":backup_id,"fenced":true,"fenceReceipt":receipt_path,"files":files.len(),"accountsCount":manifest["accountsCount"]}),
        )
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(output);
    }
    result
}

fn stream_entry<W: Write>(
    writer: &mut ArchiveWriter<W>,
    kind: u8,
    name: &str,
    args: &[&str],
) -> Result<Value, String> {
    writer
        .begin_entry(kind, name)
        .map_err(|_| "Cannot write an archive entry")?;
    let (size, sha256) = Docker.stream(args, "dump the source database", |input| {
        archive::copy_hashed(input, &mut writer.content())
            .map_err(|_| "Cannot write the database dump".into())
    })?;
    writer
        .end_entry()
        .map_err(|_| "Cannot finish the database entry")?;
    Ok(json!({"size":size,"sha256":sha256}))
}

fn capture_mount<W: Write>(
    writer: &mut ArchiveWriter<W>,
    container: &str,
    target: &str,
    prefix: &str,
    files: &mut Vec<Value>,
) -> Result<(), String> {
    Docker.stream(&["cp", &format!("{container}:{target}"), "-"], "read a source mount", |input| {
        let mut tar = tar::Archive::new(input);
        let mut names = BTreeSet::new();
        for entry in tar.entries().map_err(|_| "Cannot read the source mount archive")? {
            let mut entry = entry.map_err(|_| "Cannot read a source mount entry")?;
            let path = entry.path().map_err(|_| "A source path is not portable")?;
            let name = path.to_str().ok_or("A source path is not UTF-8; preserve it separately before moving")?;
            let (_, relative) = name.split_once('/').unwrap_or((name, ""));
            let name = if relative.is_empty() { prefix.to_owned() } else { format!("{prefix}/{relative}") };
            let kind = entry.header().entry_type();
            if kind.is_dir() { continue; }
            crate::safe_join(Path::new("."), &name).map_err(|_| "A source file path cannot safely move; classify it before exporting")?;
            if !kind.is_file() { return Err("A source mount contains a link or special file; classify it before moving".into()); }
            if !names.insert(name.clone()) { return Err("The source mount contains duplicate file names".into()); }
            let uid = entry.header().uid().map_err(|_| "Unreadable file owner")?;
            let gid = entry.header().gid().map_err(|_| "Unreadable file group")?;
            let mode = entry.header().mode().map_err(|_| "Unreadable file mode")?;
            writer.begin_entry(archive::ENTRY_FILE, &name).map_err(|_| "Cannot write a vault entry")?;
            let (size, sha256) = archive::copy_hashed(&mut entry, &mut writer.content()).map_err(|_| "Cannot copy a source file into the archive")?;
            writer.end_entry().map_err(|_| "Cannot finish a vault entry")?;
            files.push(json!({"path":name,"size":size,"sha256":sha256,"uid":uid,"gid":gid,"mode":mode,"ownershipIntent":"remap to imported account; never apply source OS ids blindly"}));
        }
        // docker cp may still have tar padding to send; drain before waiting for its exit.
        io::copy(tar.into_inner(), &mut io::sink()).map_err(|_| "Cannot finish reading the source mount")?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_incomplete_fence_is_never_accepted() {
        for receipt in [
            json!({}),
            json!({"kind":"moss-docker-fence","version":1,"stage":"fencing","containers":[]}),
            json!({"kind":"moss-docker-fence","version":1,"stage":"fenced","containers":[]}),
        ] {
            assert!(check_fence(&receipt).is_err());
        }
    }

    #[test]
    fn a_receipt_cannot_use_short_identities() {
        assert!(check_fence(&json!({"kind":"moss-docker-fence","version":1,"stage":"fenced","containers":[{"id":"db"},{"id":"app"}]})).is_err());
    }
}
