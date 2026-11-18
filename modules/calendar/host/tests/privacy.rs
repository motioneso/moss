mod support;
use safety_core::db::DataContext;
use support::{Fixture, TABLES};

#[test]
#[ignore = "Only through verify-gate"]
fn all_five_tables_reject_foreign_reads_and_writes_even_for_admins() {
    let f = Fixture::new();
    for (table, id) in TABLES.into_iter().zip(f.ids()) {
        f.rt.block_on(async {
            let cx = DataContext::open(&f.db, &f.access(f.a)).await.unwrap();
            assert_eq!(
                cx.db()
                    .query(&format!("SELECT id FROM {table} WHERE id=$1"), &[&id])
                    .await
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                cx.db()
                    .execute(
                        &format!("UPDATE {table} SET updated_at=updated_at WHERE id=$1"),
                        &[&id]
                    )
                    .await
                    .unwrap(),
                1
            );
        });
        for actor in [f.b, f.admin] {
            f.isolation(table, id, actor, false).unwrap();
            f.isolation(table, id, actor, true).unwrap();
        }
        // Observe exactly the same assertions failing with RLS removed on the
        // disposable gate database, restore it, then observe them passing.
        f.rt.block_on(
            f.root
                .batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
        let read = f.isolation(table, id, f.b, false);
        let write = f.isolation(table, id, f.b, true);
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(read.is_err(), "read proof did not detect removed RLS");
        assert!(write.is_err(), "write proof did not detect removed RLS");
        let read = read.unwrap_err().to_string();
        let write = write.unwrap_err().to_string();
        assert!(
            read.starts_with("foreign actor reached"),
            "Unexpected mutation failure: {read}"
        );
        assert!(
            write.starts_with("foreign actor reached"),
            "Unexpected mutation failure: {write}"
        );
        println!("RED {table}: {read} / {write}");
        f.isolation(table, id, f.b, false).unwrap();
        f.isolation(table, id, f.b, true).unwrap();
        println!("GREEN {table}: same read/write assertions pass with RLS restored");
    }
    f.rt.block_on(async {
        let cx=DataContext::open(&f.db,&f.access(f.b)).await.unwrap();
        assert!(cx.db().execute("INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind) VALUES(gen_random_uuid(),$1,$2,'focus')",&[&f.plan,&f.b]).await.is_err(),"forged parent accepted");
    });
    // No actor GUC at all also sees no rows (runtime connection, no DataContext).
    f.rt.block_on(async {
        let (db, c) = tokio_postgres::connect(
            &std::env::var("JS48_APP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = c.await;
        });
        for (table, id) in TABLES.into_iter().zip(f.ids()) {
            assert!(db
                .query(&format!("SELECT id FROM {table} WHERE id=$1"), &[&id])
                .await
                .unwrap()
                .is_empty());
        }
    });
    println!("PASS unrelated account, unrelated admin, missing actor and forged parent guards");
}
