#[path = "support/settings_scope.rs"]
mod settings_scope;
#[path = "support/mod.rs"]
mod support;
use moss_module_host::runtime::{DenyPorts, Ports, Request};
use safety_core::db::DataContext;
use serde_json::json;
use std::{
    sync::{mpsc, Arc},
    time::Duration,
};

#[test]
#[ignore = "Only through verify-gate"]
fn settings_lock_wait_obeys_the_guest_deadline() {
    let f = support::Fixture::new();
    let scopes = settings_scope::Scopes::new(&f, Duration::from_millis(500));
    let lock = f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &f.access(f.a)).await.unwrap();
        cx.db().execute("SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':calendar.briefing-settings',0))", &[]).await.unwrap();
        cx
    });
    let scope = scopes.next(&f);
    let ports = moss_calendar_host::CalendarPorts::new(f.db.clone(), Arc::new(DenyPorts)).unwrap();
    let (sent, received) = mpsc::channel();
    let result = std::thread::scope(|threads| {
        let waiting = threads.spawn(|| {
            let result = ports.invoke(
                &scope,
                "kv",
                &Request {
                    operation: "set".into(),
                    resource: "calendar.briefing-settings".into(),
                    parameters: json!({"lookaheadDays":0,"timeBlockMode":"auto"}),
                },
            );
            sent.send(result.is_err()).unwrap();
        });
        let result = received.recv_timeout(Duration::from_secs(2));
        // Always release the blocker before joining, even when the old code hangs.
        drop(lock);
        waiting.join().unwrap();
        result
    });
    ports.finish_call(&scope, false).unwrap();
    assert_eq!(
        result.ok(),
        Some(true),
        "Settings I/O exceeded its call deadline while waiting for the account lock"
    );
    let rows = f.rt.block_on(f.root.query("SELECT key FROM app.preferences WHERE owner_user_id=$1 AND (key LIKE 'calendar.%' OR key='assistant.action_policy.v1.calendar.calendar_writeback')", &[&f.a])).unwrap();
    assert!(
        rows.is_empty(),
        "Expired settings call persisted preferences or policy"
    );
    println!("PASS blocked settings write expires before the account lock is released and leaves no preferences or policy");
}
