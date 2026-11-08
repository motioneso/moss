//! Trusted migration service. Its privileged connection is never reachable through Ports.
//! Only parsed package SQL runs as the restricted owner; runtime access is a separate role.
use crate::{
    archive::Package,
    database::{owner_role, runtime_role},
    lifecycle::FileLifecycle,
    store::{Installed, Lifecycle},
};
use access_context::AccessContext;
use anyhow::{ensure, Result};
use safety_core::{
    db::{DataContext, Database},
    secret::Secret,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::runtime::Runtime;
use tokio_postgres::{Client, NoTls};

pub const MIGRATION: &str = r#"
CREATE TABLE moss_modules.migrations (module_id text NOT NULL, path text NOT NULL, checksum text NOT NULL, PRIMARY KEY(module_id,path));
REVOKE ALL ON moss_modules.migrations FROM PUBLIC;
CREATE TABLE moss_modules.owned_tables (module_id text NOT NULL, name text NOT NULL UNIQUE, PRIMARY KEY(module_id,name));
REVOKE ALL ON moss_modules.owned_tables FROM PUBLIC;
"#;
pub struct PostgresLifecycle {
    pub(crate) runtime: Runtime,
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
    pub(crate) async fn privileged(&self) -> Result<Client> {
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
    fn account_enabled(&self, id: &str, access: &AccessContext, default: bool) -> Result<bool> {
        self.runtime.block_on(async {
            let cx=DataContext::open(&self.app,access).await.map_err(|_|anyhow::anyhow!("Cannot open account settings"))?;
            let row=cx.db().query_opt("SELECT enabled FROM moss_modules.account_choices WHERE module_id=$1 AND actor_user_id=$2",&[&crate::jobs::module_key(id),&access.actor_user_id()]).await?;
            let enabled=row.map_or(default,|r|r.get(0));cx.commit().await.map_err(|_|anyhow::anyhow!("Cannot finish account settings"))?;Ok(enabled)
        })
    }
    fn set_account_enabled(&self, id: &str, access: &AccessContext, enabled: bool) -> Result<()> {
        self.runtime.block_on(async {
            let cx=DataContext::open(&self.app,access).await.map_err(|_|anyhow::anyhow!("Cannot open account settings"))?;
            cx.db().execute("INSERT INTO moss_modules.account_choices(module_id,actor_user_id,enabled) VALUES($1,$2,$3) ON CONFLICT(module_id,actor_user_id) DO UPDATE SET enabled=excluded.enabled",&[&crate::jobs::module_key(id),&access.actor_user_id(),&enabled]).await?;
            cx.commit().await.map_err(|_|anyhow::anyhow!("Cannot save account settings"))?;Ok(())
        })
    }

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
        self.runtime.block_on(async {self.privileged().await?.execute("INSERT INTO moss_modules.paused_modules(module_id) VALUES($1) ON CONFLICT DO NOTHING",&[&crate::jobs::module_key(id)]).await?;Ok::<_,anyhow::Error>(())})?;
        self.files.pause_jobs(id)
    }
    fn resume_jobs(&self, id: &str) -> Result<()> {
        self.runtime.block_on(async {
            let db = self.privileged().await?;
            let state: crate::store::State = serde_json::from_value(
                db.query_opt("SELECT state FROM moss_modules.catalog WHERE id=true", &[])
                    .await?
                    .map(|r| r.get::<_, Value>(0))
                    .unwrap_or_else(|| {
                        serde_json::to_value(crate::store::State::default()).expect("state")
                    }),
            )?;
            crate::jobs::reconcile(&db, id, state.installed.get(id)).await?;
            if let Some(m)=state.installed.get(id){db.execute("INSERT INTO moss_modules.account_defaults(module_id,enabled) VALUES($1,$2) ON CONFLICT(module_id) DO UPDATE SET enabled=excluded.enabled",&[&crate::jobs::module_key(id),&m.manifest.accounts.default_enabled]).await?;}
            if state
                .installed
                .get(id)
                .is_some_and(|m| m.disabled.is_none())
            {
                db.execute(
                    "DELETE FROM moss_modules.paused_modules WHERE module_id=$1",
                    &[&crate::jobs::module_key(id)],
                )
                .await?;
            }
            Ok::<_, anyhow::Error>(())
        })?;
        self.files.resume_jobs(id)
    }
    fn snapshot(&self, id: &str) -> Result<String> {
        let snapshot = self.files.snapshot(id)?;
        let contents = self.snapshot_database(id, &snapshot)?;
        self.snapshot_root(id, &snapshot)?
            .write("database.json", &serde_json::to_vec(&contents)?)?;
        Ok(snapshot)
    }
    fn migrate(&self, new: &Package, _old: Option<&Installed>) -> Result<()> {
        crate::sql::check(new, &crate::sql::LegacyInventory::default())?;
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let id=&new.manifest.id;let owner=owner_role(id);
            provision_roles(&tx, id).await?;
            // This mirror ties retained-data snapshots to both historical ledgers as well.
            for row in tx.query("SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",&[id]).await? {
                let path:String=row.get(0);let checksum:String=row.get(1);
                ensure!(new.files.contains_key(&path)&&crate::legacy::checksum(new,&path)?==checksum,"An applied migration was changed or removed");
            }
            let mut highest=0_u64;
            for path in &new.manifest.database.migrations {
                if crate::legacy::applied(&tx,new,path).await?.is_some(){highest=highest.max(crate::legacy::version(path)?.parse()?);}
            }
            for path in &new.manifest.database.migrations {
                let checksum=crate::legacy::checksum(new,path)?;
                if let Some(applied)=crate::legacy::applied(&tx,new,path).await? {
                    ensure!(applied==checksum,"An applied migration changed");
                    tx.execute("INSERT INTO moss_modules.migrations(module_id,path,checksum) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",&[id,path,&checksum]).await?;
                    continue;
                }
                ensure!(crate::legacy::version(path)?.parse::<u64>()?>highest,"A new migration must follow every applied migration");
                let legacy=crate::legacy::entry(id,path).is_some_and(|f| f.raw==crate::trust::digest(&new.files[path]));
                let role=if legacy {"jarvis_migration_owner"}else{&owner};
                tx.batch_execute(&format!("SET LOCAL ROLE {role}")).await?;
                tx.batch_execute(std::str::from_utf8(&new.files[path])?).await?;
                crate::legacy::backfill(&tx,new,path).await?;
                tx.batch_execute("RESET ROLE").await?;
                crate::legacy::record(&tx,new,path,&checksum).await?;
            }
            for table in &new.manifest.database.owned_tables {
                let actual_owner:String=tx.query_one("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=$1::text::regclass", &[table]).await?.get(0);
                let legacy=crate::legacy::owns(id,table)&&new.manifest.database.ledger!=crate::manifest::Ledger::Module&&actual_owner=="jarvis_migration_owner";
                ensure!(actual_owner==owner||legacy,"A declared table belongs to a different owner");
                if let Some(existing)=tx.query_opt("SELECT module_id FROM moss_modules.owned_tables WHERE name=$1", &[table]).await? {
                    ensure!(existing.get::<_,String>(0)==*id,"Another module owns this table");
                }
                tx.execute("INSERT INTO moss_modules.owned_tables(module_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",&[id,table]).await?;
                if !legacy {crate::rls::emit(&tx,&new.manifest,table).await?;}
            }
            tx.commit().await?;Ok(())
        })
    }
    fn restore(&self, id: &str, snapshot: &str) -> Result<()> {
        let bytes = self.snapshot_root(id, snapshot)?.read("database.json")?;
        let snapshot_data: Value = serde_json::from_slice(&bytes)?;
        self.restore_database(id, snapshot, &snapshot_data)?;
        self.files.restore(id, snapshot)
    }
    fn audit(&self, package: &Package) -> Result<()> {
        self.runtime.block_on(async {
            let mut db = self.privileged().await?;
            let tx = db.transaction().await?;
            for path in &package.manifest.database.migrations {
                let expected = crate::legacy::checksum(package, path)?;
                ensure!(
                    crate::legacy::applied(&tx, package, path).await?.as_deref()
                        == Some(expected.as_str()),
                    "An applied module migration changed or disappeared at startup"
                );
            }
            for row in tx
                .query(
                    "SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",
                    &[&package.manifest.id],
                )
                .await?
            {
                let path: String = row.get(0);
                let checksum: String = row.get(1);
                ensure!(
                    package.files.contains_key(&path)
                        && crate::legacy::checksum(package, &path)? == checksum,
                    "An applied module migration changed or disappeared at startup"
                );
            }
            tx.commit().await?;
            Ok(())
        })
    }
    fn discard_snapshot(&self, id: &str, snapshot: &str) -> Result<()> {
        ensure!(
            crate::manifest::identifier(id) && uuid::Uuid::parse_str(snapshot).is_ok(),
            "Invalid snapshot identity"
        );
        self.runtime.block_on(async {
            self.privileged()
                .await?
                .batch_execute(&format!(
                    "DROP SCHEMA IF EXISTS moss_snapshot_{} CASCADE",
                    snapshot.replace('-', "")
                ))
                .await?;
            Ok::<_, anyhow::Error>(())
        })?;
        self.files.discard_snapshot(id, snapshot)
    }
    fn purge(&self, id: &str) -> Result<()> {
        self.runtime.block_on(async {
            let mut client=self.privileged().await?;let tx=client.transaction().await?;
            let tables:Vec<String>=tx.query("SELECT name FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?.iter().map(|r|r.get(0)).collect();
            if !tables.is_empty(){tx.batch_execute(&format!("DROP TABLE {}",tables.join(","))).await?;}
            for row in tx.query("SELECT path,checksum FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await? {
                let path:String=row.get(0);let checksum:String=row.get(1);let version=crate::legacy::version(&path)?;
                tx.execute("DELETE FROM app.schema_migrations WHERE version=$1 AND name=$2 AND checksum=$3",&[&version,&&path[4..],&checksum]).await?;
            }
            tx.execute("DELETE FROM app.module_schema_migrations WHERE module_id=$1",&[&id]).await?;
            tx.execute("DELETE FROM moss_modules.migrations WHERE module_id=$1",&[&id]).await?;
            tx.execute("DELETE FROM moss_modules.owned_tables WHERE module_id=$1",&[&id]).await?;
            let runtime=runtime_role(id);let owner=owner_role(id);
            tx.batch_execute(&format!("REVOKE {runtime} FROM jarvis_app_runtime; DROP OWNED BY {runtime}; DROP OWNED BY {owner}; DROP ROLE {runtime}; DROP ROLE {owner}")).await?;
            tx.commit().await?;Ok::<_,anyhow::Error>(())
        })?;
        self.files.purge(id)
    }
}

pub(crate) async fn provision_roles(tx: &tokio_postgres::Transaction<'_>, id: &str) -> Result<()> {
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
