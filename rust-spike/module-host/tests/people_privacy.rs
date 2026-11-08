//! Actual legacy policies under both production roles. Deliberately ignored outside
//! verify-gate; never run this control against an installed application's database.
use access_context::AccessContext;
use moss_people::repository::TABLES;
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

fn fixtures(owner: Uuid, person: Uuid, identity: Uuid, link: Uuid) -> Vec<Value> {
    vec![
        json!({"id":person,"owner_user_id":owner,"display_name":"Private person"}),
        json!({"id":identity,"owner_user_id":owner,"person_id":person,"identity_kind":"alias","source_kind":"manual","normalized_value":"private","display_value":"Private"}),
        json!({"id":link,"owner_user_id":owner,"person_id":person,"source_kind":"manual","source_ref":"synthetic","source_ref_hash":"synthetic","link_kind":"related"}),
        json!({"id":Uuid::new_v4(),"owner_user_id":owner,"link_id":link,"identity_id":identity,"source_ref_hash":"synthetic","link_kind":"related"}),
        json!({"id":Uuid::new_v4(),"owner_user_id":owner,"candidate_kind":"create_person","candidate_signature":"synthetic"}),
        json!({"id":Uuid::new_v4(),"owner_user_id":owner,"event_kind":"created","person_id":person}),
        json!({"owner_user_id":owner,"source":"manual","source_ref_hash":"synthetic","source_ref":"synthetic"}),
    ]
}

fn insert_sql(table: &str, row: &Value) -> String {
    let columns = row
        .as_object()
        .unwrap()
        .keys()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!("INSERT INTO {table} ({columns}) SELECT {columns} FROM jsonb_populate_record(NULL::{table},$1::jsonb)")
}

async fn context(database: &Database, actor: Uuid) -> DataContext {
    DataContext::open(
        database,
        &AccessContext::new(actor, "people-privacy-matrix"),
    )
    .await
    .unwrap()
}

/// Return all privacy violations so the exact same assertions run with RLS removed
/// and restored. Each statement has its own rolled-back transaction.
async fn isolation(
    database: &Database,
    actor: Uuid,
    owner: Uuid,
    table: &str,
    fixture: &Value,
) -> Vec<&'static str> {
    let mut violations = vec![];
    let cx = context(database, actor).await;
    let rows = cx
        .db()
        .query(
            &format!("SELECT 1 FROM {table} WHERE owner_user_id=$1"),
            &[&owner],
        )
        .await
        .unwrap();
    if !rows.is_empty() {
        violations.push("read");
    }
    drop(cx);
    let mut forged = fixture.clone();
    if forged.get("id").is_some() {
        forged["id"] = json!(Uuid::new_v4());
    }
    if forged.get("source_ref_hash").is_some() {
        forged["source_ref_hash"] = json!(Uuid::new_v4().to_string());
    }
    if forged.get("candidate_signature").is_some() {
        forged["candidate_signature"] = json!(Uuid::new_v4().to_string());
    }
    let cx = context(database, actor).await;
    let result = cx
        .db()
        .execute(&insert_sql(table, &forged), &[&forged])
        .await;
    match result {
        Err(e) if e.code().is_some_and(|c| c.code() == "42501") => {}
        Ok(_) => violations.push("insert"),
        Err(e) => panic!("Unexpected insert failure on {table}: {e}"),
    }
    drop(cx);
    for operation in ["update", "delete"] {
        let cx = context(database, actor).await;
        let sql = if operation == "update" {
            format!("UPDATE {table} SET owner_user_id=owner_user_id WHERE owner_user_id=$1")
        } else {
            format!("DELETE FROM {table} WHERE owner_user_id=$1")
        };
        match cx.db().execute(&sql, &[&owner]).await {
            Ok(0) => {}
            Err(e)
                if table.ends_with("_events") && e.code().is_some_and(|c| c.code() == "42501") => {}
            Ok(_) => violations.push(operation),
            Err(e) => panic!("Unexpected {operation} failure on {table}: {e}"),
        }
    }
    violations
}

async fn owner_controls(
    database: &Database,
    owner: Uuid,
    other: Uuid,
    table: &str,
    fixture: &Value,
) {
    let cx = context(database, owner).await;
    assert_eq!(
        cx.db()
            .query(
                &format!("SELECT 1 FROM {table} WHERE owner_user_id=$1"),
                &[&owner]
            )
            .await
            .unwrap()
            .len(),
        1
    );
    drop(cx);
    let mut fresh = fixture.clone();
    if fresh.get("id").is_some() {
        fresh["id"] = json!(Uuid::new_v4());
    }
    if fresh.get("source_ref_hash").is_some() {
        fresh["source_ref_hash"] = json!(Uuid::new_v4().to_string());
    }
    if fresh.get("candidate_signature").is_some() {
        fresh["candidate_signature"] = json!(Uuid::new_v4().to_string());
    }
    let cx = context(database, owner).await;
    assert_eq!(
        cx.db()
            .execute(&insert_sql(table, &fresh), &[&fresh])
            .await
            .unwrap(),
        1
    );
    drop(cx);
    if !table.ends_with("_events") {
        for sql in [
            format!("UPDATE {table} SET owner_user_id=owner_user_id WHERE owner_user_id=$1"),
            format!("DELETE FROM {table} WHERE owner_user_id=$1"),
        ] {
            let cx = context(database, owner).await;
            assert_eq!(cx.db().execute(&sql, &[&owner]).await.unwrap(), 1);
        }
        let cx = context(database, owner).await;
        let error = cx
            .db()
            .execute(
                &format!("UPDATE {table} SET owner_user_id=$2 WHERE owner_user_id=$1"),
                &[&owner, &other],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code().unwrap().code(), "42501");
    }
}

#[test]
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn actual_people_policies_fail_without_rls_and_pass_with_it() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let (bootstrap,c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
        tokio::spawn(async move {let _=c.await;});
        let owner=Uuid::new_v4(); let other=Uuid::new_v4(); let admin=Uuid::new_v4();
        for (id, name, is_admin) in [(owner,"owner",false),(other,"other",false),(admin,"admin",true)] {
            bootstrap.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,$3,$4)",&[&id,&format!("people-{id}@example.test"),&name,&is_admin]).await.unwrap();
        }
        let rows = fixtures(owner,Uuid::new_v4(),Uuid::new_v4(),Uuid::new_v4());
        for (table,row) in TABLES.iter().zip(&rows) { bootstrap.execute(&insert_sql(table,row),&[row]).await.unwrap(); }
        let mut roles = vec![];
        for (name,role) in [("JS43_APP_URL",RuntimeRole::App),("JS43_WORKER_URL",RuntimeRole::Worker)] {
            roles.push((role.name(),Database::connect(&std::env::var(name).unwrap(),4,role).await.unwrap()));
        }
        for (table,row) in TABLES.iter().zip(&rows) {
            assert_forced(&bootstrap,table).await;
            // The isolated control changes no migration bytes and restores protection
            // before making assertions, even when the control detects nothing.
            bootstrap.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")).await.unwrap();
            let mut control = vec![];
            for (role,database) in &roles { for actor in [other,admin] {
                control.push((*role, actor, isolation(database,actor,owner,table,row).await));
            }}
            bootstrap.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY")).await.unwrap();
            for (role,actor,violations) in control {
                let expected = if table.ends_with("_events") {vec!["read","insert"]} else {vec!["read","insert","update","delete"]};
                assert_eq!(violations,expected,"Missing negative control for {table}, {role}, {actor}");
                println!("FAIL control, protection removed: {table} {role}: {violations:?}");
            }
            for (role,database) in &roles {
                owner_controls(database,owner,other,table,row).await;
                for actor in [other,admin] { assert!(isolation(database,actor,owner,table,row).await.is_empty(),"Privacy failed: {table} {role}"); }
                println!("PASS protection restored: {table} {role}, owner/other/admin; events retain append-only grants");
            }
        }
        bootstrap.execute("DELETE FROM app.users WHERE id=ANY($1)",&[&vec![owner,other,admin]]).await.unwrap();
    });
}

async fn assert_forced(db: &Client, table: &str) {
    let row = db
        .query_one(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::text::regclass",
            &[&table],
        )
        .await
        .unwrap();
    assert!(
        row.get::<_, bool>(0) && row.get::<_, bool>(1),
        "Missing forced RLS on {table}"
    );
}
