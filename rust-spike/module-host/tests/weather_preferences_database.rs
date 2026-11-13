//! Weather's saved place and unit through the real account-preferences port, with the
//! real guest ABI and row-level security. Run only through the weather preferences gate.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    account_preferences::{AccountPreferencesPorts, Binding, JsonShape, WEATHER_UNITS},
    manifest::Capability,
    runtime::{DenyPorts, Host, Limits},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};
use uuid::Uuid;

const LOCATION: &str = "weather-location";
const UNIT: &str = "weather-unit";
const MARKER: &str = "PLANTED-PLACE-MARKER-7c2e";

#[test]
#[ignore = "Only through the weather preferences gate"]
fn weather_place_and_unit_are_validated_private_and_shared_with_typescript() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    let admin = Uuid::new_v4();
    // Written by the TypeScript repository before this test started.
    let ts_user: Uuid = std::env::var("WEATHER_TS_USER").unwrap().parse().unwrap();
    let bootstrap = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });
        for (id, is_admin) in [(owner, false), (other, false), (admin, true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Weather proof',$3)", &[&id, &format!("{id}@example.test"), &is_admin]).await.unwrap();
        }
        db
    });
    let database = rt.block_on(Database::connect(&std::env::var("JS43_APP_URL").unwrap(), 4, RuntimeRole::App)).unwrap();
    let ports = Arc::new(
        AccountPreferencesPorts::new(
            database,
            BTreeMap::from([
                (("weather".into(), "location".into()), Binding::Json { key: LOCATION.into(), shape: JsonShape::Place }),
                (("weather".into(), "unit".into()), Binding::Json { key: UNIT.into(), shape: JsonShape::Choice(WEATHER_UNITS) }),
            ]),
            Arc::new(DenyPorts),
        )
        .unwrap(),
    );
    // The manifest declares exactly the two resources and the two operations.
    let mut manifest = common::manifest("1.0.0");
    manifest.id = "weather".into();
    manifest.capabilities = vec![Capability {
        port: "kv".into(),
        operations: ["preference.read".into(), "preference.write".into()].into(),
        resources: ["location".into(), "unit".into()].into(),
        allow_private: false,
    }];
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    let wasm = common::wasm();
    let call = |actor: Uuid, op: &str, resource: &str, parameters: Value| {
        host.call(
            &wasm,
            Arc::new(manifest.clone()),
            AccessContext::new(actor, "weather-preferences"),
            ports.clone(),
            "route",
            &json!({"operation":op,"resource":resource,"parameters":parameters}).to_string(),
        )
        .map(|reply| serde_json::from_str::<Value>(&reply).unwrap())
    };
    let read = |actor, resource: &str| call(actor, "preference.read", resource, json!({})).unwrap()["value"].clone();
    let write = |actor, resource: &str, value: Value| call(actor, "preference.write", resource, json!({"value":value}));
    let stored = |actor: Uuid, key: &str| -> Option<Value> {
        rt.block_on(bootstrap.query_opt("SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key=$2", &[&actor, &key])).unwrap().map(|r| r.get(0))
    };
    let place = json!({"lat":51.5074,"lon":-0.1278,"label":"London, UK"});

    // A valid place and unit are saved under the legacy keys, exactly as given.
    assert_eq!(write(owner, "location", place.clone()).unwrap(), json!({"value":place}));
    assert_eq!(write(owner, "unit", json!("metric")).unwrap(), json!({"value":"metric"}));
    assert_eq!(stored(owner, LOCATION), Some(place.clone()));
    assert_eq!(stored(owner, UNIT), Some(json!("metric")));
    assert_eq!(read(owner, "location"), place);

    // Out-of-range, oversized and malformed values are refused and change nothing.
    let long = "a".repeat(201);
    let bad_places = [
        json!({"lat":90.5,"lon":0,"label":"X"}),
        json!({"lat":-91,"lon":0,"label":"X"}),
        json!({"lat":0,"lon":181,"label":"X"}),
        json!({"lat":0,"lon":-180.1,"label":"X"}),
        json!({"lat":0,"lon":0,"label":long}),
        json!({"lat":0,"lon":0,"label":"   "}),
        json!({"lat":0,"lon":0,"label":MARKER,"note":"extra"}),
        json!({"lat":"0","lon":0,"label":"X"}),
        json!({"lat":0,"lon":0}),
        json!("London"),
    ];
    for bad in bad_places {
        assert!(write(owner, "location", bad.clone()).is_err(), "{bad}");
    }
    for bad in [json!("kelvin"), json!("Metric"), json!(""), json!(7), json!({"unit":"metric"})] {
        assert!(write(owner, "unit", bad.clone()).is_err(), "{bad}");
    }
    assert_eq!(stored(owner, LOCATION), Some(place.clone()));
    assert_eq!(stored(owner, UNIT), Some(json!("metric")));
    // Only the two declared resources exist, and the host picks the keys.
    assert!(call(owner, "preference.read", "other", json!({})).is_err());
    assert!(call(owner, "preference.write", "location", json!({"value":place,"key":"weather-unit"})).is_err());
    assert!(call(owner, "preference.write", "location", json!({"owner":other.to_string(),"value":place})).is_err());

    // One person's write never touches another's, and an admin has no special view.
    let other_place = json!({"lat":-33.9,"lon":151.2,"label":"Sydney"});
    assert_eq!(write(other, "location", other_place.clone()).unwrap(), json!({"value":other_place}));
    assert_eq!(read(owner, "location"), place);
    assert_eq!(stored(owner, LOCATION), Some(place.clone()));
    assert_eq!(stored(other, LOCATION), Some(other_place.clone()));
    assert_eq!(read(other, "unit"), Value::Null);
    let isolation = || {
        for stranger in [other, admin] {
            assert_ne!(read(stranger, "location"), place, "another account must not read the owner's place");
            assert_eq!(read(stranger, "unit"), Value::Null);
        }
        assert_eq!(read(admin, "location"), Value::Null);
    };
    // Negative control: with row security off in this throwaway database, the same
    // assertion must fail. Restore before the protected run.
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY")).unwrap();
    let red = catch_unwind(AssertUnwindSafe(isolation));
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY")).unwrap();
    assert!(red.is_err(), "the isolation check must fail with row security removed");
    println!("isolation assertion FAILED with row security removed");
    isolation();
    println!("isolation assertion PASSED with row security restored");

    // A malformed value stored behind the host's back reads as unset.
    rt.block_on(bootstrap.execute("UPDATE app.preferences SET value_json='\"kelvin\"'::jsonb WHERE owner_user_id=$1 AND key=$2", &[&owner, &UNIT])).unwrap();
    assert_eq!(read(owner, "unit"), Value::Null);
    rt.block_on(bootstrap.execute("UPDATE app.preferences SET value_json=$3 WHERE owner_user_id=$1 AND key=$2", &[&owner, &LOCATION, &json!({"lat":95,"lon":0,"label":MARKER})])).unwrap();
    assert_eq!(read(owner, "location"), Value::Null);

    // Values the TypeScript repository wrote read back unchanged, and a Rust write is
    // what the TypeScript side reads afterward.
    assert_eq!(read(ts_user, "location"), json!({"lat":48.8566,"lon":2.3522,"label":"Paris, France"}));
    assert_eq!(read(ts_user, "unit"), json!("imperial"));
    let rust_place = json!({"lat":35.6762,"lon":139.6503,"label":"Tokyo"});
    write(ts_user, "location", rust_place.clone()).unwrap();
    write(ts_user, "unit", json!("metric")).unwrap();
    println!("RUST_WROTE {}", json!({"location":rust_place,"unit":"metric"}));

    // Private text appears only in the preference row it was saved to: not in any other
    // table (activity rows, job payloads), and not in the refusal message.
    let refusal = format!("{:?}", write(owner, "location", json!({"lat":0,"lon":0,"label":MARKER,"note":"extra"})).unwrap_err());
    assert!(!refusal.contains(MARKER), "{refusal}");
    write(owner, "location", json!({"lat":1,"lon":2,"label":MARKER})).unwrap();
    let tables = rt.block_on(bootstrap.query("SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('app','moss_queue','moss_modules') AND table_name<>'preferences'", &[])).unwrap();
    for table in tables {
        let name: String = table.get(0);
        let count: i64 = rt.block_on(bootstrap.query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE '%'||$1||'%'"), &[&MARKER])).unwrap().get(0);
        assert_eq!(count, 0, "the planted place text reached {name}");
    }
}
