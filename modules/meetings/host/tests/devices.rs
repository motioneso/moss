//! Companion device store and pairing against a real database. Each protection is also shown
//! failing with the protection removed. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
#[path = "devices_lifecycle.rs"]
mod lifecycle;
use moss_meetings_host::{
    device_store::{Check, DeviceStore, Use},
    pairing::{credential_shape, digest, Decision, NewAttempt, PairingStore, Pending, Redeemed},
};
use safety_core::db::{Database, RuntimeRole};
use support::Fixture;
use uuid::Uuid;

fn attempt(platform: &str) -> NewAttempt {
    NewAttempt {
        verifier_hash: digest("verifier-secret"),
        device_name: "Proof Mac".into(),
        platform: platform.into(),
        app_version: "1.0".into(),
        os_version: "14.0".into(),
        recording_proof_hash: None,
        recording_policy_version: None,
    }
}

struct World {
    fx: Fixture,
    pairing: PairingStore,
    devices: DeviceStore,
}

fn world() -> World {
    let fx = Fixture::new();
    let auth = fx.rt.block_on(async {
        Database::connect(&std::env::var("JS48_AUTH_URL").unwrap(), 4, RuntimeRole::Auth).await.unwrap()
    });
    let pairing = PairingStore::new(auth);
    let devices = DeviceStore::new(fx.db.clone());
    World { fx, pairing, devices }
}

/// Pairs one device for `owner` through the real create, decide and redeem steps.
async fn pair(w: &World, owner: Uuid, platform: &str) -> (Uuid, String) {
    let mut a = attempt(platform);
    a.verifier_hash = digest("verifier-secret");
    let created = w.pairing.create(a).await.unwrap();
    // The Android path needs a live browser session, so the test plants one as the owner.
    let session = Uuid::new_v4();
    w.fx
        .root
        .execute(
            "INSERT INTO app.better_auth_sessions(id, user_id, token, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')",
            &[&session, &owner, &session.to_string()],
        )
        .await
        .unwrap();
    let done = w.pairing.decide(&created.approval_code, true, owner, Some(session), None).await.unwrap();
    assert_eq!(done, Decision::Done);
    match w.pairing.redeem(created.attempt_id, "verifier-secret").await.unwrap() {
        Redeemed::Issued(i) => (i.device_id, i.credential),
        Redeemed::Not(_) => panic!("approved attempt did not issue"),
    }
}

#[test]
#[ignore]
fn pairing_issues_one_credential_and_stores_only_its_digest() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        assert!(credential_shape(&credential, "tm1_"));
        // Only the digest is stored: the raw credential appears in no column of any row.
        let stored: String = w
            .fx
            .root
            .query_one("SELECT credential_hash FROM app.companion_devices WHERE id = $1", &[&device])
            .await
            .unwrap()
            .get(0);
        assert_eq!(stored, digest(&credential));
        assert_ne!(stored, credential);
        let leaked: i64 = w
            .fx
            .root
            .query_one("SELECT count(*) FROM app.companion_devices d WHERE d::text LIKE '%' || $1 || '%'", &[&credential])
            .await
            .unwrap()
            .get(0);
        assert_eq!(leaked, 0);
        // A second redeem and a wrong verifier both stop short of issuing anything.
        let attempt_id: Uuid = w
            .fx
            .root
            .query_one("SELECT pair_attempt_id FROM app.companion_devices WHERE id = $1", &[&device])
            .await
            .unwrap()
            .get(0);
        assert!(matches!(w.pairing.redeem(attempt_id, "verifier-secret").await.unwrap(), Redeemed::Not(Pending::Redeemed)));
        assert!(matches!(w.pairing.redeem(attempt_id, "wrong").await.unwrap(), Redeemed::Not(Pending::Unknown)));
        // Cancel takes the issued device with it.
        w.pairing.cancel(attempt_id, "verifier-secret").await.unwrap();
        assert!(w.devices.get(w.fx.a, device).await.unwrap().is_none());
    });
}

#[test]
#[ignore]
fn resolver_returns_a_live_row_and_fails_without_its_policy() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        let hash = digest(&credential);
        let resolve = |sql: &'static str| {
            let root = &w.fx.root;
            let hash = hash.clone();
            async move { root.query(sql, &[&hash]).await.unwrap() }
        };
        // The resolver is called as the app role in production. Root runs it here as the
        // definer-owned function, which is what the policy has to admit.
        let live = resolve("SELECT user_id, device_id, platform FROM app.resolve_companion_device($1)").await;
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].get::<_, Uuid>(1), device);
        assert_eq!(live[0].get::<_, Uuid>(0), w.fx.a);

        // Remove the policy the owner role depends on and the lookup finds nothing.
        w.fx
            .root
            .batch_execute("ALTER POLICY companion_devices_auth_runtime ON app.companion_devices USING (false)")
            .await
            .unwrap();
        assert!(resolve("SELECT user_id FROM app.resolve_companion_device($1)").await.is_empty());
        w.fx
            .root
            .batch_execute("ALTER POLICY companion_devices_auth_runtime ON app.companion_devices USING (true)")
            .await
            .unwrap();
        assert_eq!(resolve("SELECT user_id FROM app.resolve_companion_device($1)").await.len(), 1);

        // Expired and revoked devices are refused.
        w.fx.root.execute("UPDATE app.companion_devices SET expires_at = now() - interval '1 minute' WHERE id = $1", &[&device]).await.unwrap();
        assert!(resolve("SELECT user_id FROM app.resolve_companion_device($1)").await.is_empty());
        w.fx.root.execute("UPDATE app.companion_devices SET expires_at = now() + interval '1 day' WHERE id = $1", &[&device]).await.unwrap();
        w.pairing.logout(&credential).await.unwrap();
        assert!(resolve("SELECT user_id FROM app.resolve_companion_device($1)").await.is_empty());
    });
}

#[test]
#[ignore]
fn resolver_slides_expiry_but_never_past_the_cap() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        w.fx
            .root
            .execute("UPDATE app.companion_devices SET absolute_expires_at = now() + interval '2 days' WHERE id = $1", &[&device])
            .await
            .unwrap();
        w.fx.root.query("SELECT * FROM app.resolve_companion_device($1)", &[&digest(&credential)]).await.unwrap();
        let capped: bool = w
            .fx
            .root
            .query_one("SELECT expires_at = absolute_expires_at FROM app.companion_devices WHERE id = $1", &[&device])
            .await
            .unwrap()
            .get(0);
        assert!(capped);
    });
}

#[test]
#[ignore]
fn one_person_cannot_see_another_persons_devices() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, _) = pair(&w, w.fx.a, "macos").await;
        assert_eq!(w.devices.list(w.fx.a).await.unwrap().len(), 1);
        for other in [w.fx.b, w.fx.admin] {
            assert!(w.devices.list(other).await.unwrap().is_empty());
            assert!(w.devices.get(other, device).await.unwrap().is_none());
            assert!(!w.devices.rename(other, device, "Taken").await.unwrap());
            assert!(!w.devices.heartbeat(other, device, "9", "9").await.unwrap());
            assert!(matches!(w.devices.check_device(other, device, Use::Focus).await.unwrap(), Check::Refused("unlinked")));
        }

        // Without the owner filter the same request leaks, so the filter is what protects.
        w.fx
            .root
            .batch_execute(
                "CREATE OR REPLACE VIEW app.companion_devices_owner AS \
                 SELECT d.id, d.user_id, d.display_name, d.platform, d.app_version, d.os_version, d.created_at, \
                        d.last_contact_at, d.expires_at, d.absolute_expires_at, NULL::integer AS capability_revision \
                   FROM app.companion_devices d",
            )
            .await
            .unwrap();
        assert!(w.devices.get(w.fx.b, device).await.unwrap().is_some(), "view without filter must leak");
        w.fx.root.batch_execute(&format!("DROP VIEW app.companion_devices_owner; {}", moss_module_host::companion_devices::MIGRATION)).await.unwrap();
        assert!(w.devices.get(w.fx.b, device).await.unwrap().is_none());
    });
}

#[test]
#[ignore]
fn check_device_names_the_reason() {
    let w = world();
    w.fx.rt.block_on(async {
        let (mac, _) = pair(&w, w.fx.a, "macos").await;
        let (ring, _) = pair(&w, w.fx.a, "android").await;
        assert_eq!(
            w.devices.check_device(w.fx.a, mac, Use::ScreenHistory).await.unwrap(),
            Check::Allowed { device_name: "Proof Mac".into() }
        );
        assert_eq!(w.devices.check_device(w.fx.a, ring, Use::Focus).await.unwrap(), Check::Refused("wrong_kind"));
        assert_eq!(w.devices.check_device(w.fx.a, Uuid::new_v4(), Use::Focus).await.unwrap(), Check::Refused("unlinked"));
        w.pairing.revoke_all_for(w.fx.a).await.unwrap();
        assert_eq!(w.devices.check_device(w.fx.a, mac, Use::Focus).await.unwrap(), Check::Refused("unlinked"));
    });
}

/// Column names that would carry a secret.
fn secretive(name: &str) -> bool {
    ["hash", "credential", "verifier", "proof", "pair_attempt"].iter().any(|w| name.contains(w))
}

#[test]
#[ignore]
fn neither_store_exposes_a_hash() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        // The view the device store reads has no secret column.
        let columns: Vec<String> = w
            .fx
            .root
            .query(
                "SELECT attname::text FROM pg_attribute WHERE attrelid = 'app.companion_devices_owner'::regclass AND attnum > 0",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert!(!columns.is_empty() && columns.iter().all(|c| !secretive(c)), "{columns:?}");
        // The detector is live: pointed at the real table it flags the credential column.
        let table: Vec<String> = w
            .fx
            .root
            .query("SELECT attname::text FROM pg_attribute WHERE attrelid = 'app.companion_devices'::regclass AND attnum > 0", &[])
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert!(table.iter().any(|c| secretive(c)));
        // What the store returns, serialised, holds neither the digest nor the credential.
        let json = serde_json::to_string(&w.devices.get(w.fx.a, device).await.unwrap().unwrap()).unwrap();
        assert!(!json.contains(&digest(&credential)) && !json.contains(&credential));
        // The app role cannot read the table or call a function that returns a hash.
        let app = w.fx.db.clone();
        let cx = safety_core::db::DataContext::open(&app, &w.fx.access(w.fx.a)).await.unwrap();
        assert!(cx.db().query("SELECT credential_hash FROM app.companion_devices", &[]).await.is_err());
    });
}

#[test]
#[ignore]
fn heartbeat_and_rename_change_only_the_owners_device() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, _) = pair(&w, w.fx.a, "macos").await;
        assert!(w.devices.rename(w.fx.a, device, "Desk Mac").await.unwrap());
        assert!(w.devices.heartbeat(w.fx.a, device, "2.0", "15.0").await.unwrap());
        let d = w.devices.get(w.fx.a, device).await.unwrap().unwrap();
        assert_eq!((d.display_name.as_str(), d.app_version.as_str(), d.os_version.as_str()), ("Desk Mac", "2.0", "15.0"));
        assert!(d.last_contact_at.is_some());
    });
}

#[test]
#[ignore]
fn a_deactivated_account_gets_no_ring_session() {
    let w = world();
    w.fx.rt.block_on(async {
        let (_, credential) = pair(&w, w.fx.b, "android").await;
        assert!(w.pairing.ring_session(&credential).await.unwrap().is_some());
        w.fx.root.execute("UPDATE app.users SET status = 'deactivated' WHERE id = $1", &[&w.fx.b]).await.unwrap();
        assert!(w.pairing.ring_session(&credential).await.unwrap().is_none());
    });
}

#[test]
#[ignore]
fn admin_revoke_removes_devices_and_sessions_together_or_not_at_all() {
    let w = world();
    w.fx.rt.block_on(async {
        // An android pairing leaves one live browser session for the owner.
        let (device, _) = pair(&w, w.fx.b, "android").await;
        let count = |sql: &'static str| {
            let root = &w.fx.root;
            let id = w.fx.b;
            async move { root.query_one(sql, &[&id]).await.unwrap().get::<_, i64>(0) }
        };
        let devices = "SELECT count(*) FROM app.companion_devices WHERE user_id = $1";
        let sessions = "SELECT count(*) FROM app.better_auth_sessions WHERE user_id = $1";
        assert_eq!((count(devices).await, count(sessions).await), (1, 1));
        // A failing session delete must undo the device delete.
        w.fx.root
            .batch_execute(
                "CREATE FUNCTION app.refuse_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'session delete refused'; END $$;
                 CREATE TRIGGER refuse_session_delete BEFORE DELETE ON app.better_auth_sessions FOR EACH ROW EXECUTE FUNCTION app.refuse_session_delete();",
            )
            .await
            .unwrap();
        assert!(w.pairing.revoke_all_for(w.fx.b).await.is_err());
        assert_eq!((count(devices).await, count(sessions).await), (1, 1), "a failed revoke changed something");
        w.fx.root
            .batch_execute("DROP TRIGGER refuse_session_delete ON app.better_auth_sessions; DROP FUNCTION app.refuse_session_delete();")
            .await
            .unwrap();
        assert_eq!(w.pairing.revoke_all_for(w.fx.b).await.unwrap(), 2);
        assert_eq!((count(devices).await, count(sessions).await), (0, 0));
        let _ = device;
    });
}

#[test]
#[ignore]
fn a_deactivated_accounts_credential_is_never_extended() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        let soon = "now() + interval '10 days'";
        w.fx
            .root
            .execute(&format!("UPDATE app.companion_devices SET expires_at = {soon} WHERE id = $1"), &[&device])
            .await
            .unwrap();
        let read = || async {
            let r = w
                .fx
                .root
                .query_one("SELECT expires_at, last_contact_at FROM app.companion_devices WHERE id = $1", &[&device])
                .await
                .unwrap();
            (r.get::<_, chrono::DateTime<chrono::Utc>>(0), r.get::<_, Option<chrono::DateTime<chrono::Utc>>>(1))
        };
        let before = read().await;
        w.fx.root.execute("UPDATE app.users SET status = 'deactivated' WHERE id = $1", &[&w.fx.a]).await.unwrap();
        // The device still resolves so the caller can name the state, but nothing is extended.
        let rows = w.fx.root.query("SELECT * FROM app.resolve_companion_device($1)", &[&digest(&credential)]).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(read().await, before, "a deactivated account's credential was extended");
        w.fx.root.execute("UPDATE app.users SET status = 'active' WHERE id = $1", &[&w.fx.a]).await.unwrap();
        w.fx.root.query("SELECT * FROM app.resolve_companion_device($1)", &[&digest(&credential)]).await.unwrap();
        assert!(read().await.0 > before.0, "an active account's credential should slide");
    });
}

#[test]
#[ignore]
fn unlink_removes_only_the_owners_device_and_ends_its_credential() {
    let w = world();
    w.fx.rt.block_on(async {
        let (device, credential) = pair(&w, w.fx.a, "macos").await;
        let hash = digest(&credential);
        let live = || async {
            w.fx
                .root
                .query("SELECT 1 FROM app.resolve_companion_device($1)", &[&hash])
                .await
                .unwrap()
                .len()
        };
        assert_eq!(live().await, 1);

        // Another person guessing the id removes nothing and learns nothing.
        assert!(!w.pairing.unlink(w.fx.b, device).await.unwrap());
        assert!(w.devices.get(w.fx.a, device).await.unwrap().is_some());
        assert_eq!(live().await, 1);

        assert!(w.pairing.unlink(w.fx.a, device).await.unwrap());
        assert!(w.devices.get(w.fx.a, device).await.unwrap().is_none());
        assert_eq!(live().await, 0);
        assert!(!w.pairing.unlink(w.fx.a, device).await.unwrap());
    });
}
