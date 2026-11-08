#![allow(dead_code)]
use access_context::AccessContext;
use safety_core::db::{DataContext, Database, RuntimeRole};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

pub const TABLES: [&str; 5] = [
    "app.calendar_events",
    "app.day_plans",
    "app.day_plan_blocks",
    "app.day_plan_operations",
    "app.day_plan_operation_items",
];
pub struct Fixture {
    pub rt: tokio::runtime::Runtime,
    pub root: Client,
    pub db: Database,
    pub a: Uuid,
    pub b: Uuid,
    pub admin: Uuid,
    pub event: Uuid,
    pub plan: Uuid,
    pub block: Uuid,
    pub operation: Uuid,
    pub item: Uuid,
}
impl Fixture {
    pub fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let ids: Vec<Uuid> = (0..9).map(|_| Uuid::new_v4()).collect();
        let (a, b, admin, event, plan, block, operation, item, account) = (
            ids[0], ids[1], ids[2], ids[3], ids[4], ids[5], ids[6], ids[7], ids[8],
        );
        let(root,db)=rt.block_on(async {
            let(root,c)=tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
            tokio::spawn(async move{let _=c.await;});
            if !root.query_one("SELECT to_regnamespace('moss_modules') IS NOT NULL",&[]).await.unwrap().get::<_,bool>(0) {
                root.batch_execute(moss_module_host::postgres::MIGRATION).await.unwrap();
                root.batch_execute(moss_module_host::migrations::MIGRATION).await.unwrap();
            }
            root.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$4,'Calendar A',true),($2,$5,'Calendar B',false),($3,$6,'Other admin',true)",&[&a,&b,&admin,&format!("{a}@example.test"),&format!("{b}@example.test"),&format!("{admin}@example.test")]).await.unwrap();
            root.execute("INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,encrypted_secret,scopes) VALUES($1,'google',$2,'{}',ARRAY['https://www.googleapis.com/auth/calendar'])",&[&account,&a]).await.unwrap();
            root.execute("INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id) VALUES($1,$2,$3,'Owner event','2026-11-08T10:00:00Z','2026-11-08T11:00:00Z','calendar-proof')",&[&event,&account,&a]).await.unwrap();
            root.execute("INSERT INTO app.day_plans(id,owner_user_id,local_day,time_zone) VALUES($1,$2,'2026-11-08','UTC')",&[&plan,&a]).await.unwrap();
            root.execute("INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,actual_placement) VALUES($1,$2,$3,'focus','Recorded block','{\"startsAt\":\"2026-11-08T10:00:00Z\",\"durationMinutes\":60,\"calendarEventRef\":null}')",&[&block,&plan,&a]).await.unwrap();
            root.execute("INSERT INTO app.day_plan_operations(id,plan_id,owner_user_id,kind,idempotency_key,expected_revision) VALUES($1,$2,$3,'apply','calendar-proof',1)",&[&operation,&plan,&a]).await.unwrap();
            root.execute("INSERT INTO app.day_plan_operation_items(id,operation_id,plan_id,owner_user_id,block_id,kind,pending_change) VALUES($1,$2,$3,$4,$5,'remove','{\"kind\":\"remove\"}')",&[&item,&operation,&plan,&a,&block]).await.unwrap();
            let db=Database::connect(&std::env::var("JS48_APP_URL").unwrap(),8,RuntimeRole::App).await.unwrap();
            (root,db)
        });
        Self {
            rt,
            root,
            db,
            a,
            b,
            admin,
            event,
            plan,
            block,
            operation,
            item,
        }
    }
    pub fn access(&self, actor: Uuid) -> AccessContext {
        AccessContext::new(actor, "calendar-proof")
    }
    pub fn ids(&self) -> [Uuid; 5] {
        [self.event, self.plan, self.block, self.operation, self.item]
    }
    pub fn isolation(&self, table: &str, id: Uuid, actor: Uuid, write: bool) -> anyhow::Result<()> {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &self.access(actor))
                .await
                .map_err(|_| anyhow::anyhow!("Data context unavailable"))?;
            let rows = if write {
                cx.db()
                    .execute(
                        &format!("UPDATE {table} SET updated_at=updated_at WHERE id=$1"),
                        &[&id],
                    )
                    .await?
            } else {
                cx.db()
                    .query(&format!("SELECT id FROM {table} WHERE id=$1"), &[&id])
                    .await?
                    .len() as u64
            };
            anyhow::ensure!(rows == 0, "foreign actor reached {table} (write={write})");
            // Roll back even the no-op UPDATE. No mutation survives an assertion.
            Ok(())
        })
    }
    pub fn core(&self) -> Vec<u8> {
        std::fs::read(std::env::var("CALENDAR_CORE_WASM").unwrap()).unwrap()
    }
}
