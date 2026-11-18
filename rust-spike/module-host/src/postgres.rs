//! Catalog adapter for the existing safety-core data context. Configuration rows contain no
//! private module data. Runtime roles receive only the admin policy, never table ownership.
use crate::store::{CatalogStore, State};
use access_context::AccessContext;
use anyhow::{ensure, Result};
use safety_core::db::{DataContext, Database};
use tokio::runtime::Runtime;

pub const MIGRATION: &str = r#"
CREATE SCHEMA moss_modules;
REVOKE ALL ON SCHEMA moss_modules FROM PUBLIC;
GRANT USAGE ON SCHEMA moss_modules TO jarvis_app_runtime;
CREATE TABLE moss_modules.catalog (id boolean PRIMARY KEY DEFAULT true CHECK(id), revision bigint NOT NULL, state jsonb NOT NULL);
ALTER TABLE moss_modules.catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_modules.catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_admin ON moss_modules.catalog TO jarvis_app_runtime
USING ((SELECT is_instance_admin FROM app.get_user_by_id(nullif(current_setting('app.actor_user_id',true),'')::uuid)))
WITH CHECK ((SELECT is_instance_admin FROM app.get_user_by_id(nullif(current_setting('app.actor_user_id',true),'')::uuid)));
GRANT SELECT, INSERT, UPDATE ON moss_modules.catalog TO jarvis_app_runtime;
"#;
pub struct PostgresCatalog {
    database: Database,
    access: AccessContext,
    runtime: Runtime,
}
impl PostgresCatalog {
    pub fn new(database: Database, access: AccessContext) -> Result<Self> {
        Ok(Self {
            database,
            access,
            runtime: Runtime::new()?,
        })
    }
    async fn context(&self) -> Result<DataContext> {
        let cx = DataContext::open(&self.database, &self.access)
            .await
            .map_err(|_| anyhow::anyhow!("Could not open the configuration data context"))?;
        let row = cx
            .db()
            .query_opt(
                "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
                &[&self.access.actor_user_id()],
            )
            .await?;
        ensure!(
            row.is_some_and(|r| r.get::<_, bool>(0)),
            "An administrator must approve module configuration"
        );
        Ok(cx)
    }
}
impl CatalogStore for PostgresCatalog {
    fn load(&self) -> Result<State> {
        self.runtime.block_on(async {
            let cx = self.context().await?;
            let row = cx
                .db()
                .query_opt("SELECT state FROM moss_modules.catalog WHERE id=true", &[])
                .await?;
            let state = match row {
                Some(row) => serde_json::from_value(row.get(0))?,
                None => State::default(),
            };
            cx.commit()
                .await
                .map_err(|_| anyhow::anyhow!("Could not commit the configuration data context"))?;
            Ok(state)
        })
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        ensure!(
            next.revision == expected + 1,
            "The catalog revision must advance once"
        );
        self.runtime.block_on(async {
            let cx=self.context().await?;
            cx.db().query_one("SELECT pg_advisory_xact_lock(hashtext('moss:module-catalog'))",&[]).await?;
            let row=cx.db().query_opt("SELECT revision FROM moss_modules.catalog WHERE id=true FOR UPDATE",&[]).await?;
            ensure!(row.as_ref().map_or(0,|row|row.get::<_,i64>(0) as u64)==expected,"Another module change finished first; try again");
            let state=serde_json::to_value(next)?;
            cx.db().execute("INSERT INTO moss_modules.catalog(id,revision,state) VALUES(true,$1,$2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state",&[&(next.revision as i64),&state]).await?;
            cx.commit().await.map_err(|_|anyhow::anyhow!("Could not commit the configuration data context"))?;Ok(())
        })
    }
}
