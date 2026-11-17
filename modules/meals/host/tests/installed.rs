//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-7d2e41";

/// The plan tests never run a model. Every call fails, so no test can pass by reaching one by accident.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("This test does not call a model")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("This part does not embed")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("MEALS_COMPONENT_WASM")
            .expect("Run modules/meals/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The database role the host runs the package's queries as. Meals is an old module whose
/// tables the host already knew about, so it uses the shared app role.
fn role() -> String {
    "jarvis_app_runtime".to_owned()
}

/// Reads as the package's database role with the actor set, so row security applies as it does at run time.
fn rows_as(f: &support::Fixture, actor: uuid::Uuid, sql: &str) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) = tokio_postgres::connect(
            &std::env::var("JS48_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.batch_execute(&format!("SET LOCAL ROLE {}", role()))
            .await
            .unwrap();
        tx.execute(
            "SELECT set_config('app.actor_user_id', $1, true)",
            &[&actor.to_string()],
        )
        .await
        .unwrap();
        let rows = tx.query(sql, &[]).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
}

struct World {
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            let ready = f
                .root
                .query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[])
                .await
                .unwrap()
                .get::<_, bool>(0);
            if !ready {
                f.root
                    .batch_execute(moss_platform_jobs::MIGRATION)
                    .await
                    .unwrap();
                f.root
                    .batch_execute(moss_module_host::jobs::MIGRATION)
                    .await
                    .unwrap();
            }
        });
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[]))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_meals_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(NoModel),
                version: "0.1.0".parse().unwrap(),
                browser_dir: None,
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
            |next| Ok(next),
        )
        .unwrap();
        let source = app
            .installer
            .refresh(
                &f.access(f.a),
                Source::Folder(reg.path().into()),
                &key,
                &publisher,
                "meals-test-registry",
            )
            .unwrap();
        app.installer
            .install(&f.access(f.a), &source, &artifact, true)
            .unwrap();
        Self {
            f,
            app,
            _dirs: (dir, reg),
        }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(
                    self.f.access(actor),
                    method,
                    &format!("/api/m/meals{path}"),
                    &body.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    }
    fn add_user(&self) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Meals Parity',false)",
            &[&id, &format!("{id}@example.test")],
        )).unwrap();
        id
    }
}

#[path = "support/tools.rs"]
mod tools;
