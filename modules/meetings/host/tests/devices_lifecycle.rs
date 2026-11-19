use super::*;
use moss_module_host::purge_hooks::{set_purge_hook, PurgeHook};
use std::sync::Arc;

const TABLES: [&str; 4] = [
    "companion_devices",
    "companion_pair_attempts",
    "companion_recording_capabilities",
    "companion_recording_attempts",
];

fn install(w: &World) -> support::install::Installed {
    let installed = support::install::install(&w.fx);
    set_purge_hook("meetings", Arc::new(w.pairing.clone()));
    installed
}

fn seed(w: &World) -> (Uuid, String) {
    w.fx.rt.block_on(async {
        let old = pair(w, w.fx.a, "macos").await;
        let (ring, _) = pair(w, w.fx.b, "android").await;
        w.pairing.create(attempt("macos")).await.unwrap(); // no account yet
        w.fx.root.execute("UPDATE app.companion_devices SET expires_at = now() - interval '1 day' WHERE id = $1", &[&ring]).await.unwrap();
        w.fx.root.execute("INSERT INTO app.companion_recording_capabilities(device_id,owner_user_id,proof_hash,policy_version,revision,approved_at) VALUES($1,$2,$3,1,1,now())", &[&ring,&w.fx.b,&"a".repeat(64)]).await.unwrap();
        w.fx.root.execute("INSERT INTO app.companion_recording_attempts(owner_user_id,device_id,request_key,proof_hash,policy_version,created_at,expires_at) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 hour')", &[&w.fx.b,&ring,&Uuid::new_v4(),&"b".repeat(64)]).await.unwrap();
        for name in TABLES {
            let count: i64 = w.fx.root.query_one(&format!("SELECT count(*) FROM app.{name}"), &[]).await.unwrap().get(0);
            assert!(count > 0, "seeded {name}");
        }
        old
    })
}

fn assert_empty(w: &World) {
    w.fx.rt.block_on(async {
        for name in TABLES {
            // A dropped table fails this same query, rather than masquerading as zero rows.
            let count: i64 = w.fx.root.query_one(&format!("SELECT count(*) FROM app.{name}"), &[]).await.unwrap().get(0);
            assert_eq!(count, 0, "{name} remains empty and present");
        }
        let count: i64 = w.fx.root.query_one("SELECT count(*) FROM app.schema_migrations WHERE version IN ('0238','0239','0287','0330')", &[]).await.unwrap().get(0);
        assert_eq!(count, 4, "core ledger is unchanged");
    });
}

#[test]
#[ignore = "Only through verify-gate"]
fn removal_forgets_all_devices_but_keeps_core_tables_and_browser_sessions() {
    let w = world();
    let installed = install(&w);
    seed(&w);
    let sessions = || {
        w.fx.rt.block_on(async {
            w.fx.root
                .query_one("SELECT count(*) FROM app.better_auth_sessions", &[])
                .await
                .unwrap()
                .get::<_, i64>(0)
        })
    };
    let before = sessions();
    installed
        .app
        .installer
        .remove(&w.fx.access(w.fx.a), "meetings", None)
        .unwrap();
    assert!(
        !w.fx.rt.block_on(w.devices.list(w.fx.a)).unwrap().is_empty(),
        "keeping data keeps devices"
    );
    installed
        .app
        .installer
        .remove(&w.fx.access(w.fx.a), "meetings", Some("Meetings"))
        .unwrap();
    assert_empty(&w);
    assert_eq!(sessions(), before);
}

#[test]
#[ignore = "Only through verify-gate"]
fn reinstall_after_purge_pairs_a_new_device_without_reviving_the_old_one() {
    let w = world();
    let installed = install(&w);
    let (old, credential) = seed(&w);
    installed
        .app
        .installer
        .remove(&w.fx.access(w.fx.a), "meetings", Some("Meetings"))
        .unwrap();
    assert_empty(&w);
    // Reinstall the same signed package through its registry, with the same host and ledger.
    installed
        .app
        .installer
        .install(
            &w.fx.access(w.fx.a),
            &installed.meetings.0,
            &installed.meetings.1,
            true,
        )
        .unwrap();
    let session = Uuid::new_v4();
    w.fx.rt.block_on(async {
        w.fx.root.execute("INSERT INTO app.better_auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", &[&session,&w.fx.a,&session.to_string()]).await.unwrap();
    });
    let mut child = std::process::Command::new("python3")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/support/companion_http.py"),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(serde_json::json!({"owner":w.fx.a,"session":session,"modules":installed.app.installer.data_path()}).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "real pairing routes after reinstall"
    );
    let new: Uuid = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    w.fx.rt.block_on(async {
        assert_ne!(old, new);
        assert!(w.devices.get(w.fx.a, old).await.unwrap().is_none());
        assert_eq!(w.devices.list(w.fx.a).await.unwrap().len(), 1);
        assert!(w
            .fx
            .root
            .query(
                "SELECT * FROM app.resolve_companion_device($1)",
                &[&digest(&credential)]
            )
            .await
            .unwrap()
            .is_empty());
    });
}

struct Refuse;
impl PurgeHook for Refuse {
    fn purge(&self) -> anyhow::Result<()> {
        anyhow::bail!("cleanup unavailable")
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn pairing_work_finishes_before_purge_and_cannot_run_after_removal() {
    use std::{sync::mpsc, time::Duration};
    let w = world();
    let installed = install(&w);
    let installer = installed.app.installer.clone();
    let access = w.fx.access(w.fx.a);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (removed_tx, removed_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let lease = installer.clone();
        scope.spawn(move || lease.while_installed("meetings", || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        }).unwrap());
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        scope.spawn(move || {
            removed_tx.send(installer.remove(&access, "meetings", Some("Meetings"))).unwrap();
        });
        assert!(matches!(removed_rx.recv_timeout(Duration::from_millis(200)), Err(mpsc::RecvTimeoutError::Timeout)));
        release_tx.send(()).unwrap();
        removed_rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap();
    });
    let result: anyhow::Result<()> = installed.app.installer.while_installed("meetings", || anyhow::bail!("pairing ran after removal"));
    let error = format!("{:#}", result.unwrap_err());
    assert!(error.contains("not installed"), "{error}");
    assert_empty(&w);
}

#[test]
#[ignore = "Only through verify-gate"]
fn cleanup_failure_stops_removal_before_any_module_table_is_dropped() {
    let w = world();
    let installed = install(&w);
    let (old, _) = seed(&w);
    set_purge_hook("meetings", Arc::new(Refuse));
    let result = installed
        .app
        .installer
        .remove(&w.fx.access(w.fx.a), "meetings", Some("Meetings"));
    set_purge_hook("meetings", Arc::new(w.pairing.clone()));
    assert!(format!("{:#}", result.unwrap_err()).contains("cleanup unavailable"));
    assert!(installed
        .app
        .installer
        .export_list()
        .unwrap()
        .modules
        .iter()
        .any(|m| m.id == "meetings"));
    assert!(w
        .fx
        .rt
        .block_on(w.devices.get(w.fx.a, old))
        .unwrap()
        .is_some());
    w.fx.rt.block_on(async {
        assert!(w
            .fx
            .root
            .query_one("SELECT to_regclass('app.meeting_records') IS NOT NULL", &[])
            .await
            .unwrap()
            .get::<_, bool>(0));
    });
}
