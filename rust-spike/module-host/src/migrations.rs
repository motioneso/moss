//! Trusted migration service. Its privileged connection is never reachable through Ports.
//! Only parsed package SQL runs as the restricted owner; runtime access is a separate role.
use crate::{
    archive::Package,
    database::{owner_role, runtime_role},
    lifecycle::FileLifecycle,
    store::{Installed, Lifecycle},
};
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use safety_core::{
    db::{DataContext, Database},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::runtime::Runtime;
use tokio_postgres::{Client, NoTls};

pub const MIGRATION: &str = r#"
CREATE TABLE moss_modules.migrations (module_id text NOT NULL, path text NOT NULL, checksum text NOT NULL, PRIMARY KEY(module_id,path));
REVOKE ALL ON moss_modules.migrations FROM PUBLIC;
CREATE TABLE moss_modules.owned_tables (module_id text NOT NULL, name text NOT NULL UNIQUE, PRIMARY KEY(module_id,name));
REVOKE ALL ON moss_modules.owned_tables FROM PUBLIC;
"#;
pub struct PostgresLifecycle {
    runtime: Runtime,
    privileged: Secret,
    app: Database,
    files: FileLifecycle,
    data: PathBuf,
}
impl PostgresLifecycle {
    /// The privileged address belongs to the host's migration service, not a runtime pool.
    pub fn new(privileged: Secret, app: Database, data: &Path) -> Result<Self> {
        Ok(Self {
            runtime: Runtime::new()?,
            privileged,
            app,
            files: FileLifecycle::new(data, Default::default())?,
            data: data.into(),
        })
    }
    async fn privileged(&self) -> Result<Client> {
        let (client, connection) = tokio_postgres::connect(self.privileged.expose_secret(), NoTls)
            .await
            .map_err(|_| anyhow::anyhow!("Could not connect the migration service"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    }
    fn snapshot_root(&self, id: &str, snapshot: &str) -> Result<vault::Root> {
        ensure!(
            crate::manifest::identifier(id) && uuid::Uuid::parse_str(snapshot).is_ok(),
            "Invalid snapshot identity"
        );
        Ok(vault::Root::open(
            &self.data.join("modules/snapshots").join(id).join(snapshot),
        )?)
    }
}
impl Lifecycle for PostgresLifecycle {
    fn is_admin(&self, access: &AccessContext) -> Result<bool> {
        self.runtime.block_on(async {
            let cx = DataContext::open(&self.app, access)
                .await
                .map_err(|_| anyhow::anyhow!("Could not check administrator permission"))?;
            let row = cx
                .db()
                .query_opt(
                    "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
                    &[&access.actor_user_id()],
                )
                .await?;
            let admin = row.is_some_and(|row| row.get::<_, bool>(0));
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not finish the administrator check"))?;
            Ok(admin)
        })
    }
    fn pause_jobs(&self, id: &str) -> Result<()> {
        self.files.pause_jobs(id)
    }
    fn resume_jobs(&self, id: &str) -> Result<()> {
        self.files.resume_jobs(id)
    }
    fn snapshot(&self, id: &str) -> Result<String> {
        let snapshot = self.files.snapshot(id)?;
        let contents=self.runtime.block_on(async {
            let client=self.privileged().await?;
            let schema=format!("moss_snapshot_{}",snapshot.replace('-',""));
            client.batch_execute(&format!("CREATE SCHEMA {schema}; REVOKE ALL ON SCHEMA {schema} FROM PUBLIC")).await?;
            let mut tables=BTreeMap::<String,Value>::new();
            // Retained data still exists after code removal. Snapshot the durable ownership
            // ledger, including on reinstall, rather than only currently installed manifests.
            let owned:Vec<String>=client.query("SELECT name FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?.iter().map(|row|row.get(0)).collect();
                for table in &owned {
                    let name=table.strip_prefix("app.").context("Invalid owned table")?;
                    client.batch_execute(&format!("CREATE TABLE {schema}.{name} (LIKE {table} INCLUDING ALL); INSERT INTO {schema}.{name} SELECT * FROM {table}")).await?;
                    let foreign_keys:Vec<Value>=client.query("SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=$1::text::regclass AND contype='f'",&[table]).await?.iter().map(|r|json!({"name":r.get::<_,String>(0),"definition":r.get::<_,String>(1)})).collect();
                    tables.insert(table.clone(),json!(foreign_keys));
                }
            let ledger:Vec<Value>=client.query("SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?.iter().map(|row|json!({"path":row.get::<_,String>(0),"checksum":row.get::<_,String>(1)})).collect();
            Ok::<_,anyhow::Error>(json!({"schema":schema,"tables":tables,"ledger":ledger}))
        })?;
        self.snapshot_root(id, &snapshot)?
            .write("database.json", &serde_json::to_vec(&contents)?)?;
        Ok(snapshot)
    }
    fn migrate(&self, new: &Package, _old: Option<&Installed>) -> Result<()> {
        ensure!(
            new.manifest.jobs.is_empty(),
            "Connect the queue lifecycle service before installing a module with scheduled jobs"
        );
        ensure!(
            new.manifest.database.ledger == crate::manifest::Ledger::Module,
            "Legacy SQL requires the release's legacy ledger adapter"
        );
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let id=&new.manifest.id;let owner=owner_role(id);let runtime=runtime_role(id);
            provision_roles(&tx, id).await?;
            for row in tx.query("SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",&[id]).await? {
                let path:String=row.get(0);let checksum:String=row.get(1);
                ensure!(new.files.get(&path).is_some_and(|bytes|crate::trust::digest(bytes)==checksum),"An applied migration was changed or removed");
            }
            for path in &new.manifest.database.migrations {
                let checksum=crate::trust::digest(&new.files[path]);
                if let Some(row)=tx.query_opt("SELECT checksum FROM moss_modules.migrations WHERE module_id=$1 AND path=$2",&[id,path]).await? {
                    ensure!(row.get::<_,String>(0)==checksum,"An applied migration changed");continue;
                }
                tx.batch_execute(&format!("SET LOCAL ROLE {owner}")).await?;
                tx.batch_execute(std::str::from_utf8(&new.files[path])?).await?;
                tx.batch_execute("RESET ROLE").await?;
                tx.execute("INSERT INTO moss_modules.migrations(module_id,path,checksum) VALUES($1,$2,$3)",&[id,path,&checksum]).await?;
            }
            for table in &new.manifest.database.owned_tables {
                let actual_owner:String=tx.query_one("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=$1::text::regclass", &[table]).await?.get(0);
                ensure!(actual_owner==owner,"A declared table belongs to a different owner");
                if let Some(existing)=tx.query_opt("SELECT module_id FROM moss_modules.owned_tables WHERE name=$1", &[table]).await? {
                    ensure!(existing.get::<_,String>(0)==*id,"Another module owns this table");
                }
                tx.execute("INSERT INTO moss_modules.owned_tables(module_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",&[id,table]).await?;
                tx.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY; DROP POLICY IF EXISTS moss_module_actor ON {table}; CREATE POLICY moss_module_actor ON {table} TO {runtime} USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id()); GRANT SELECT,INSERT,UPDATE,DELETE ON {table} TO {runtime}")).await?;
            }
            tx.commit().await?;Ok(())
        })
    }
    fn restore(&self, id: &str, snapshot: &str) -> Result<()> {
        let bytes = self.snapshot_root(id, snapshot)?.read("database.json")?;
        let snapshot_data: Value = serde_json::from_slice(&bytes)?;
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let tables=snapshot_data["tables"].as_object().context("The database snapshot is invalid")?;
            let schema=snapshot_data["schema"].as_str().context("The snapshot schema is missing")?;
            ensure!(schema==format!("moss_snapshot_{}",snapshot.replace('-',"")),"Invalid snapshot schema");
            let current:Vec<String>=tx.query("SELECT name FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?.iter().map(|r|r.get(0)).collect();
            if !current.is_empty() {tx.batch_execute(&format!("DROP TABLE {}",current.join(","))).await?;}
            let owner=owner_role(id);let runtime=runtime_role(id);
            provision_roles(&tx, id).await?;
            for table in tables.keys() {
                ensure!(table.starts_with(&format!("app.{}_",id.replace(['.','-'],"_"))) && table[4..].bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_'),"Invalid snapshot table");
                let name=&table[4..];
                // Copy, rather than consume, the snapshot so recovery can be repeated.
                tx.batch_execute(&format!("CREATE TABLE {table} (LIKE {schema}.{name} INCLUDING ALL); INSERT INTO {table} SELECT * FROM {schema}.{name}; ALTER TABLE {table} OWNER TO {owner}; ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY; CREATE POLICY moss_module_actor ON {table} TO {runtime} USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id()); GRANT SELECT,INSERT,UPDATE,DELETE ON {table} TO {runtime}")).await?;
            }
            for (table,foreign_keys) in tables {
                for key in foreign_keys.as_array().context("Invalid foreign key snapshot")? {
                    let name=key["name"].as_str().context("Missing foreign key name")?.replace('"', "\"\"");
                    let definition=key["definition"].as_str().context("Missing foreign key definition")?;
                    tx.batch_execute(&format!("ALTER TABLE {table} ADD CONSTRAINT \"{name}\" {definition}")).await?;
                }
            }
            tx.execute("DELETE FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?;
            for table in tables.keys() {tx.execute("INSERT INTO moss_modules.owned_tables(module_id,name) VALUES($1,$2)",&[&id,table]).await?;}
            tx.execute("DELETE FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?;
            for row in snapshot_data["ledger"].as_array().context("The snapshot ledger is invalid")? {
                tx.execute("INSERT INTO moss_modules.migrations(module_id,path,checksum) VALUES($1,$2,$3)",&[&id,&row["path"].as_str().context("Missing path")?,&row["checksum"].as_str().context("Missing checksum")?]).await?;
            }
            tx.commit().await?;Ok::<_,anyhow::Error>(())
        })?;
        self.files.restore(id, snapshot)
    }
    fn purge(&self, id: &str) -> Result<()> {
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let row=tx.query_one("SELECT state FROM moss_modules.catalog WHERE id=true",&[]).await?;
            let state:crate::store::State=serde_json::from_value(row.get(0))?;
            let module=state.installed.get(id).or_else(|| state.retained.get(id)).context("This module has no retained data")?;
            if !module.manifest.database.owned_tables.is_empty() {
                tx.batch_execute(&format!("DROP TABLE {}",module.manifest.database.owned_tables.join(","))).await?;
            }
            tx.execute("DELETE FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?;
            tx.execute("DELETE FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?;
            let runtime=runtime_role(id);let owner=owner_role(id);
            tx.batch_execute(&format!("REVOKE {runtime} FROM jarvis_app_runtime; DROP OWNED BY {runtime}; DROP OWNED BY {owner}; DROP ROLE {runtime}; DROP ROLE {owner}")).await?;
            tx.commit().await?;Ok::<_,anyhow::Error>(())
        })?;
        self.files.purge(id)
    }
}

async fn provision_roles(tx: &tokio_postgres::Transaction<'_>, id: &str) -> Result<()> {
    let owner = owner_role(id);
    let runtime = runtime_role(id);
    for role in [&owner, &runtime] {
        if tx
            .query_opt("SELECT 1 FROM pg_roles WHERE rolname=$1", &[role])
            .await?
            .is_none()
        {
            tx.batch_execute(&format!("CREATE ROLE {role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS")).await?;
        }
        let flags = tx
            .query_one(
                "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",
                &[role],
            )
            .await?;
        ensure!(
            !flags.get::<_, bool>(0) && !flags.get::<_, bool>(1),
            "A module role can bypass row security"
        );
    }
    tx.batch_execute(&format!("GRANT USAGE, CREATE ON SCHEMA app TO {owner}; GRANT REFERENCES(id) ON app.users TO {owner}; GRANT USAGE ON SCHEMA app TO {runtime}; GRANT EXECUTE ON FUNCTION app.current_actor_user_id() TO {runtime}; GRANT {runtime} TO jarvis_app_runtime WITH INHERIT FALSE")).await?;
    Ok(())
}
