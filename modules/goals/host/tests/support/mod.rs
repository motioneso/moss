#![allow(dead_code)]
use access_context::AccessContext;
use tokio_postgres::{Client, NoTls};
use safety_core::db::{Database, RuntimeRole};
use uuid::Uuid;

pub struct Fixture {
    pub rt: tokio::runtime::Runtime,
    pub root: Client,
    pub db: Database,
    pub a: Uuid,
    pub b: Uuid,
    pub admin: Uuid,
}
impl Fixture {
    pub fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b, admin) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            if !root
                .query_one("SELECT to_regnamespace('moss_modules') IS NOT NULL", &[])
                .await
                .unwrap()
                .get::<_, bool>(0)
            {
                root.batch_execute(moss_module_host::postgres::MIGRATION).await.unwrap();
                root.batch_execute(moss_module_host::migrations::MIGRATION).await.unwrap();
            }
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$4,'Goal A',true),($2,$5,'Goal B',false),($3,$6,'Goal Admin',true)",
                &[&a, &b, &admin, &format!("{a}@example.test"), &format!("{b}@example.test"), &format!("{admin}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        Self { rt, root, db, a, b, admin }
    }
    pub fn access(&self, actor: Uuid) -> AccessContext {
        AccessContext::new(actor, "goals-proof")
    }
}
