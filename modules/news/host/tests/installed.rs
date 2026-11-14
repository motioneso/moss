//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Host, Limits, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-4f1c9b";
/// Its own marker, so the saved source of the adding test does not show in the other scan.
const ADD_MARK: &str = "PLANTED-ADD-MARKER-91c3d7";

/// The person's model approves every publisher. The prompt is kept so tests can read it.
struct Approves(std::sync::Mutex<Vec<String>>);
impl moss_module_host::ai::Intelligence for Approves {
    fn generate(&self, _: &CallScope, request: &Request) -> anyhow::Result<Value> {
        self.0.lock().unwrap().push(request.parameters.to_string());
        Ok(json!({"text": "{\"allowed\":true,\"category\":\"news_publisher\"}"}))
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("News does not embed")
    }
}

/// Answers public-web reads from a fixed site, so the database tests need no network. The live
/// run uses the real fetch path instead. Every other call goes to the real host services.
struct Web(Arc<dyn moss_module_host::runtime::Ports>);
impl moss_module_host::runtime::Ports for Web {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if port != "fetch" {
            return self.0.invoke(scope, port, request);
        }
        let url = request.parameters["url"].as_str().unwrap_or_default();
        let found = |content_type: &str, body: &str| {
            json!({"ok":true,"status":200,"finalUrl":url,"contentType":content_type,"body":body,"truncated":false,"hopCount":0,"encoding":"utf-8"})
        };
        if url.starts_with("https://news.example.com/rss?q=") {
            return Ok(found(
                "application/rss+xml",
                "<rss><channel><title>x</title><item><title>First story here</title><link>https://news.example.com/1</link></item></channel></rss>",
            ));
        }
        Ok(match url {
            "https://daily.sample.test/" => found(
                "text/html",
                "<html><head><title>Sample Daily</title><link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head></html>",
            ),
            "https://daily.sample.test/feed.xml" => found(
                "application/rss+xml",
                "<rss><channel><title>x</title><item><title>First story here</title><link>https://daily.sample.test/1</link></item></channel></rss>",
            ),
            "https://news.example.com/" => found(
                "text/html",
                "<html><head><title>Example Daily</title><link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head></html>",
            ),
            "https://news.example.com/feed.xml" => found(
                "application/rss+xml",
                "<rss><channel><title>x</title><item><title>First story here</title><link>https://news.example.com/1</link></item></channel></rss>",
            ),
            _ => json!({"ok":false,"reason":"network"}),
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.0.finish_call(scope, success)
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("NEWS_COMPONENT_WASM")
            .expect("Run modules/news/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Reads as the app role with the actor set, so row security applies as it does at run time.
fn rows_as(
    f: &support::Fixture,
    actor: uuid::Uuid,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) =
            tokio_postgres::connect(&std::env::var("JS48_APP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.execute("SELECT set_config('app.actor_user_id', $1, true)", &[&actor.to_string()]).await.unwrap();
        let rows = tx.query(sql, params).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
}

/// One installed News package on a fresh database.
struct World {
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            let ready = f.root.query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0);
            if !ready {
                f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
                f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
            }
        });
        // An earlier test in this database installed the package into a folder that is gone.
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[])).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_news_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(Approves(Default::default())),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
            |next| Ok(Arc::new(Web(next))),
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "news-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(self.f.access(actor), method, &format!("/api/m/news{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    }
    /// Calls the package's public export entry as the actor.
    fn export(&self, actor: uuid::Uuid) -> Value {
        let manifest = moss_news_host::package::manifest().unwrap();
        let payload = json!({"name":"collectNewsPersonalizationExportSection","parameters":{}}).to_string();
        let ports: Arc<dyn moss_module_host::runtime::Ports> = Arc::new(
            moss_module_host::transactional_database::TransactionalDatabasePorts::new(
                self.f.db.clone(),
                Arc::new(moss_module_host::context::ContextPorts::new(self.app.services.clone())),
            )
            .unwrap(),
        );
        let out = Host::new(Limits::default()).unwrap().call(
            &component(),
            Arc::new(manifest),
            AccessContext::new(actor, "news-export"),
            ports,
            "api",
            &payload,
        );
        let answer: Value = serde_json::from_str(&out.expect("the export finished")).unwrap();
        assert!(answer.get("error").is_none(), "{answer}");
        answer["ok"].clone()
    }
    fn count(&self, table: &str, who: uuid::Uuid) -> i64 {
        self.f
            .rt
            .block_on(self.f.root.query_one(&format!("SELECT count(*) FROM {table} WHERE owner_user_id=$1"), &[&who]))
            .unwrap()
            .get(0)
    }
    /// Plants the rows the routes cannot create yet (they need the network), as root, for one person.
    fn plant(&self, who: uuid::Uuid) -> (String, String, String) {
        self.f.rt.block_on(async {
            let c = &self.f.root;
            let src = |domain: &str, feed: Option<&str>| {
                let domain = domain.to_owned();
                let feed = feed.map(str::to_owned);
                (domain, feed)
            };
            let mut ids = vec![];
            for (domain, feed) in [src("example.com", Some("https://bridge.example.net/feed")), src("news.example.net", None)] {
                let row = c
                    .query_one(
                        "INSERT INTO app.news_custom_sources(owner_user_id,label,canonical_domain,homepage_url,feed_url,retrieval_method,validation_status,health_status,validation_fingerprint,validated_at,confirmed_fetch_hosts)
                         VALUES($1,$2,$2,'https://'||$2||'/',$3,CASE WHEN $3::text IS NULL THEN 'scrape' ELSE 'feed' END,'approved','healthy','fp-secret',now(),ARRAY[$2]) RETURNING id::text",
                        &[&who, &domain, &feed],
                    )
                    .await
                    .unwrap();
                ids.push(row.get::<_, String>(0));
            }
            let topic: String = c
                .query_one(
                    "INSERT INTO app.news_custom_topics(owner_user_id,label,guidance,validation_status,validation_fingerprint,validated_at)
                     VALUES($1,'Space','keep it short','approved','fp-secret',now()) RETURNING id::text",
                    &[&who],
                )
                .await
                .unwrap()
                .get(0);
            c.execute(
                "INSERT INTO app.news_compilation_snapshots(owner_user_id,compiled_at,expires_at,payload)
                 VALUES($1,'2026-11-11T10:00:00Z','2026-11-11T12:00:00Z',$2)",
                &[&who, &json!({"articles":[
                    {"canonicalDomain":"example.com","title":"a"},
                    {"canonicalDomain":"deep.example.com","title":"b"},
                    {"canonicalDomain":"news.example.net","title":"c"},
                    {"canonicalDomain":"example.org","title":"d"},
                    {"canonicalDomain":"keep.test","title":"e"}]})],
            )
            .await
            .unwrap();
            c.execute("INSERT INTO app.news_refresh_state(owner_user_id,state) VALUES($1,'idle') ON CONFLICT DO NOTHING", &[&who]).await.unwrap();
            c.execute(
                "INSERT INTO app.news_policy_verdicts(owner_user_id,canonical_domain,fingerprint,verdict,expires_at) VALUES($1,'example.com','fp-secret','approved',now()+interval '1 day') ON CONFLICT DO NOTHING",
                &[&who],
            )
            .await
            .unwrap();
            c.execute(
                "INSERT INTO app.news_source_credentials(owner_user_id,source_id,connection_id,encrypted_secret,status) VALUES($1,$2::text::uuid,'conn','{\"c\":\"sealed\"}'::jsonb,'configured')",
                &[&who, &ids[0]],
            )
            .await
            .unwrap();
            (ids[0].clone(), ids[1].clone(), topic)
        })
    }
}

const NEWS_TABLES: [&str; 8] = [
    "app.news_prefs",
    "app.news_custom_sources",
    "app.news_custom_topics",
    "app.news_source_exclusions",
    "app.news_compilation_snapshots",
    "app.news_refresh_state",
    "app.news_policy_verdicts",
    "app.news_source_credentials",
];

#[test]
#[ignore = "Only through verify-gate"]
fn choices_exclusions_and_removals_work_and_the_old_sql_rules_hold() {
    let w = World::new();
    let a = w.f.a;
    let first = w.call(a, "POST", "/prefs", json!({"kind":"source","key":"bbc"}));
    let again = w.call(a, "POST", "/prefs", json!({"kind":"source","key":"bbc"}));
    assert_eq!(first["status"], 200, "{first}");
    assert_eq!(first["body"]["pref"]["id"], again["body"]["pref"]["id"], "a repeat returns the same choice");
    assert_eq!(w.count("app.news_prefs", a), 1);
    println!("PASS route: saving the same choice twice keeps one row");

    // The unique rule in SQL 0151 refuses a repeat from direct SQL too.
    let dup = w.f.rt.block_on(w.f.root.execute("INSERT INTO app.news_prefs(owner_user_id,kind,key) VALUES($1,'source','bbc')", &[&a]));
    assert!(dup.is_err(), "the database must refuse a repeat choice");
    println!("PASS sql 0151: the database itself refuses a repeat choice");

    let ex = w.call(a, "POST", "/source-exclusions", json!({"source":"https://Example.com/x"}));
    assert_eq!(ex["body"]["exclusion"]["canonicalDomain"], "example.com", "{ex}");
    let dup = w.f.rt.block_on(w.f.root.execute("INSERT INTO app.news_source_exclusions(owner_user_id,canonical_domain) VALUES($1,'example.com')", &[&a]));
    assert!(dup.is_err(), "the database must refuse a repeat exclusion");
    println!("PASS sql 0159: the database itself refuses a repeat exclusion");

    // The guest never writes refresh state, so no row appears.
    assert_eq!(w.count("app.news_refresh_state", a), 0);
    let read = w.call(a, "GET", "/personalization", Value::Null);
    assert_eq!(read["body"]["refresh"]["state"], "idle", "{read}");
    println!("PASS refresh: reads answer idle and nothing is written to refresh state");
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_see_change_or_remove_news_data_and_the_check_fails_without_row_security() {
    let w = World::new();
    let (a, b, admin) = (w.f.a, w.f.b, w.f.admin);
    let (src, _, topic) = w.plant(a);
    let pref = w.call(a, "POST", "/prefs", json!({"kind":"source","key":"bbc"}))["body"]["pref"]["id"].as_str().unwrap().to_owned();
    let excl = w.call(a, "POST", "/source-exclusions", json!({"source":"example.org"}))["body"]["exclusion"]["id"].as_str().unwrap().to_owned();

    for who in [b, admin] {
        assert_eq!(w.call(who, "GET", "/prefs", Value::Null)["body"], json!({"prefs":[]}));
        let read = w.call(who, "GET", "/personalization", Value::Null)["body"].clone();
        assert_eq!(
            (&read["customSources"], &read["customTopics"], &read["sourceExclusions"], &read["snapshot"]),
            (&json!([]), &json!([]), &json!([]), &Value::Null)
        );
        assert_eq!(w.call(who, "DELETE", &format!("/prefs/{pref}"), Value::Null)["body"], json!({"ok":false}));
        assert_eq!(w.call(who, "DELETE", &format!("/source-exclusions/{excl}"), Value::Null)["body"], json!({"ok":false}));
        assert_eq!(w.call(who, "DELETE", &format!("/topics/{topic}"), Value::Null)["body"], json!({"deleted":false}));
        assert_eq!(w.call(who, "DELETE", &format!("/sources/{src}"), Value::Null)["body"], json!({"deleted":false}));
        assert_eq!(w.call(who, "PATCH", &format!("/topics/{topic}"), json!({"label":"x"}))["status"], 400);
    }
    // B excluding the same publisher must not prune A's saved feed.
    w.call(b, "POST", "/source-exclusions", json!({"source":"example.com"}));
    let articles: i32 = rows_as(&w.f, a, "SELECT jsonb_array_length(payload->'articles') FROM app.news_compilation_snapshots", &[])[0].get(0);
    assert_eq!(articles, 5, "B's actions left A's saved feed whole");
    for table in ["app.news_prefs", "app.news_custom_sources", "app.news_custom_topics", "app.news_source_exclusions", "app.news_compilation_snapshots"] {
        let count_for = |who| -> i64 { rows_as(&w.f, who, &format!("SELECT count(*) FROM {table}"), &[])[0].get(0) };
        let mine = count_for(a);
        assert!(mine >= 1, "{table} has A's row");
        let others = count_for(admin);
        assert_eq!(others, 0, "{table}: an admin sees none of A's rows");
    }
    println!("GREEN: B and an admin see, change and remove none of A's News rows");

    // With row security removed the same direct read leaks A's rows to the admin.
    for table in NEWS_TABLES.iter() {
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open: i64 = rows_as(&w.f, admin, &format!("SELECT count(*) FROM {table}"), &[])[0].get(0);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(open >= 1, "RED expected: {table} leaks with row security removed, got {open}");
        let shut: i64 = rows_as(&w.f, admin, &format!("SELECT count(*) FROM {table}"), &[])[0].get(0);
        assert_eq!(shut, 0, "{table} restored");
        println!("RED then GREEN: {table} leaks with row security removed and is closed again after");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn typed_text_reaches_no_other_table_and_the_export_holds_only_the_owner_rows() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let tail = format!("{MARK}-tail");
    for (method, path, body) in [
        ("POST", "/prefs", json!({"kind":"source","key":MARK})),
        ("POST", "/prefs", json!({"kind":"topic","key":tail})),
        ("POST", "/source-exclusions", json!({"source":format!("{MARK}.example.com")})),
        ("POST", "/source-exclusions", json!({"source":format!("https://u:{MARK}@example.com")})),
        ("POST", "/topics", json!({"label":MARK,"guidance":MARK})),
    ] {
        let out = w.call(a, method, path, body);
        assert!(out["status"].as_u64().unwrap() < 500 || out["status"] == 503, "{out}");
    }
    // The one accepted write that carries typed text is the owner's own exclusion row.
    assert_eq!(w.count("app.news_source_exclusions", a), 1);
    w.call(b, "POST", "/source-exclusions", json!({"source":"theirs.example"}));

    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') \
                 OR table_name LIKE 'news\\_%'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")), "{tables:?}");
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE lower(to_jsonb(t)::text) LIKE '%'||lower($1)||'%'"), &[&MARK])).unwrap().get(0);
        let allowed = table == "news_source_exclusions" || table == "app.news_source_exclusions";
        assert!(hits == 0 || allowed, "{table} holds typed text");
    }
    println!("PASS privacy: scanned {} tables, the planted text is only in the owner's own exclusion row", tables.len());

    let (src, _, topic) = w.plant(a);
    w.plant(b);
    let export = w.export(a);
    assert_eq!(export["custom_sources"].as_array().unwrap().len(), 2);
    assert_eq!(export["custom_topics"][0]["id"], json!(topic));
    assert_eq!(export["custom_sources"].as_array().unwrap().iter().filter(|s| s["id"] == json!(src)).count(), 1);
    assert!(export["source_exclusions"].as_array().unwrap().iter().all(|e| e["ownerUserId"] == json!(a.to_string())));
    assert!(!export.to_string().contains("theirs.example"), "B's exclusion must not be in A's export");
    assert!(!export.to_string().contains("fp-secret"), "the validation marker is never exported");
    println!("PASS export: A's export holds A's rows only and no validation marker");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_installed_routes_answer_like_the_old_routes_step_for_step() {
    let w = World::new();
    // The old server runs for its own person so the two sides never share rows.
    let old_actor = w.f.b;
    let before = replay::steps_before_ids();
    let old = replay::old_routes(old_actor, &before, json!({}));
    let mut new = Vec::new();
    for step in &before {
        let url = step["url"].as_str().unwrap().replace("/api/news", "");
        new.push(w.call(w.f.a, step["method"].as_str().unwrap(), &url, step.get("body").cloned().unwrap_or(Value::Null)));
    }
    compare(&before, &old, &new);

    // Steps that name a row need the id each side made or planted.
    let (old_src, _, old_topic) = w.plant(old_actor);
    let (new_src, _, new_topic) = w.plant(w.f.a);
    let id_of = |answers: &[Value], key: &str, nested: &str| answers[answers.iter().position(|r| r["body"][key].is_object()).unwrap()]["body"][key][nested].as_str().unwrap().to_owned();
    let (old_pref, new_pref) = (id_of(&old, "pref", "id"), id_of(&new, "pref", "id"));
    let (old_excl, new_excl) = (id_of(&old, "exclusion", "id"), id_of(&new, "exclusion", "id"));
    let steps = replay::steps_with_ids();
    let old2 = replay::old_routes(
        old_actor,
        &steps,
        json!({"pref":old_pref,"excl":old_excl,"src":old_src,"topic":old_topic}),
    );
    let vars = json!({"pref":new_pref,"excl":new_excl,"src":new_src,"topic":new_topic});
    let new2: Vec<Value> = steps
        .iter()
        .map(|s| {
            let url = replay::fill(s["url"].as_str().unwrap(), &vars).replace("/api/news", "");
            w.call(w.f.a, s["method"].as_str().unwrap(), &url, s.get("body").cloned().unwrap_or(Value::Null))
        })
        .collect();
    compare(&steps, &old2, &new2);
    println!("PASS parity: {} steps matched the old routes", old.len() + old2.len());

    // Adding a source: refusals, a preview, a save and the answers after it. The old side runs for
    // the same person that planted the rows above, so the fresh site avoids their exclusions.
    let adding = replay::steps_adding_before_save();
    let saving = replay::steps_adding_save();
    // The old preview store lives in its process, so the old side runs preview and save together.
    let all: Vec<Value> = adding.iter().chain(saving.iter()).cloned().collect();
    let old_all = replay::old_routes(old_actor, &all, json!({}));
    let (old3, old4) = old_all.split_at(adding.len());
    let new3: Vec<Value> = adding
        .iter()
        .map(|s| w.call(w.f.a, s["method"].as_str().unwrap(), &s["url"].as_str().unwrap().replace("/api/news", ""), s.get("body").cloned().unwrap_or(Value::Null)))
        .collect();
    compare(&adding, old3, &new3);
    let conf = new3.last().unwrap()["body"]["confirmationId"].as_str().unwrap().to_owned();
    let vars = json!({"conf":conf});
    let new4: Vec<Value> = saving
        .iter()
        .map(|s| {
            let body = s.get("body").map(|b| serde_json::from_str(&replay::fill(&b.to_string(), &vars)).unwrap()).unwrap_or(Value::Null);
            w.call(w.f.a, s["method"].as_str().unwrap(), &s["url"].as_str().unwrap().replace("/api/news", ""), body)
        })
        .collect();
    compare(&saving, old4, &new4);
    println!("PASS parity: {} adding-a-source steps matched the old routes", old3.len() + old4.len());

    // The old server queues a refresh after a write, so only the Rust shape is checked here.
    let read = w.call(w.f.a, "GET", "/personalization", Value::Null);
    assert_eq!(read["body"]["refresh"]["state"], "idle", "{read}");
}

/// Compares two answer lists with ids and times masked. The refresh block and the saved feed article count differ on purpose.
fn compare(steps: &[Value], old: &[Value], new: &[Value]) {
    assert_eq!(old.len(), new.len());
    for (i, ((step, o), n)) in steps.iter().zip(old).zip(new).enumerate() {
        let (mut o, mut n) = (o.clone(), n.clone());
        for side in [&mut o, &mut n] {
            if let Some(body) = side["body"].as_object_mut() {
                body.remove("refresh");
            }
            // The old routes prune the saved feed on exclusion. The package leaves it for part 5b.
            if let Some(snapshot) = side["body"]["snapshot"].as_object_mut() {
                snapshot.remove("articleCount");
            }
        }
        replay::mask(&mut o);
        replay::mask(&mut n);
        assert_eq!(o, n, "step {i} {} {} differs\nold: {o}\nnew: {n}", step["method"], step["url"]);
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn overview_serves_the_stored_page_like_the_old_route_and_only_to_its_owner() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    // A valid stored page, fresh for a week, with two stories from one added source.
    let payload = json!({"articles":[
        {"id":"story-a","publisher":"Daily Example","canonicalDomain":"daily.example.com","headline":"First stored story","url":"https://daily.example.com/a","publishedAt":"2026-11-11T09:00:00.000Z","excerpt":"One","imageUrl":null,"topics":[],"preferred":true,"rank":1},
        {"id":"story-b","publisher":"Daily Example","canonicalDomain":"daily.example.com","headline":"Second stored story","url":"https://daily.example.com/b","publishedAt":"2026-11-11T08:00:00.000Z","excerpt":null,"imageUrl":null,"topics":["World"],"preferred":true,"rank":2}
    ]});
    for who in [a, b] {
        w.f.rt.block_on(w.f.root.execute(
            "INSERT INTO app.news_compilation_snapshots(owner_user_id,compiled_at,expires_at,payload) VALUES($1,now(),now()+interval '7 days',$2)",
            &[&who, &payload],
        )).unwrap();
    }
    // The old route answers for b (its own rows), the package for a. The stored pages are equal.
    let steps = vec![json!({"method":"GET","url":"/api/news/overview"})];
    let old = replay::old_routes(b, &steps, json!({}));
    let new = vec![w.call(a, "GET", "/overview", Value::Null)];
    compare(&steps, &old, &new);
    assert_eq!(new[0]["body"]["topStories"][0]["title"], json!("First stored story"), "{new:?}");
    // Removing the stored page for b leaves b with none of a's stories.
    w.f.rt.block_on(w.f.root.execute("DELETE FROM app.news_compilation_snapshots WHERE owner_user_id=$1", &[&b])).unwrap();
    let other = w.call(b, "GET", "/overview", Value::Null);
    assert!(!other.to_string().contains("First stored story"), "{other}");
    println!("PASS overview: stored page matches the old route and stays with its owner");
}

#[test]
#[ignore = "Only through verify-gate"]
fn adding_a_source_is_private_to_the_person_who_previewed_it() {
    let w = World::new();
    let (a, b, admin) = (w.f.a, w.f.b, w.f.admin);
    let shown = w.call(a, "POST", "/sources/preview", json!({"input":"news.example.com"}));
    assert_eq!(shown["body"]["status"], "ok", "{shown}");
    let id = shown["body"]["confirmationId"].clone();

    // B cannot save A's preview, and A's preview survives the attempt.
    let stolen = w.call(b, "POST", "/sources", json!({"confirmationId": id}));
    assert_eq!(stolen["status"], 409, "{stolen}");
    assert_eq!(w.count("app.news_custom_sources", b), 0);
    let saved = w.call(a, "POST", "/sources", json!({"confirmationId": id}));
    assert_eq!(saved["status"], 201, "{saved}");
    assert_eq!(w.count("app.news_custom_sources", a), 1);
    assert_eq!(saved["body"]["source"]["feedUrl"], "https://news.example.com/feed.xml");

    // B previews the same publisher with no duplicate and a verdict of their own.
    let theirs = w.call(b, "POST", "/sources/preview", json!({"input":"news.example.com"}));
    assert!(theirs["body"].get("duplicateOfSourceId").is_none(), "{theirs}");
    assert_eq!((w.count("app.news_policy_verdicts", a), w.count("app.news_policy_verdicts", b)), (1, 1));

    // Nobody else sees A's source or verdict, as the app role with row security on.
    for who in [b, admin] {
        let read = w.call(who, "GET", "/personalization", Value::Null)["body"]["customSources"].clone();
        assert_eq!(read, json!([]), "{read}");
    }
    let seen: i64 = rows_as(&w.f, admin, "SELECT count(*) FROM app.news_custom_sources", &[])[0].get(0);
    assert_eq!(seen, 0, "an admin sees none of A's sources");
    println!("GREEN: B and an admin cannot save, see or reuse A's preview, source or verdict");

    // With row security removed, the same read leaks A's rows to the admin.
    for table in ["app.news_custom_sources", "app.news_policy_verdicts"] {
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open: i64 = rows_as(&w.f, admin, &format!("SELECT count(*) FROM {table}"), &[])[0].get(0);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert!(open >= 1, "RED expected: {table} leaks with row security removed, got {open}");
        println!("RED then GREEN: {table} leaks with row security removed and is closed again after");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn text_typed_into_adding_a_source_reaches_no_job_or_log_table() {
    let w = World::new();
    let a = w.f.a;
    // A feed address carrying the marker is previewed and saved for real, so the policy check and
    // the save both run with the typed text in hand.
    let typed = format!("news.example.com/rss?q={ADD_MARK}");
    let out = w.call(a, "POST", "/sources/preview", json!({"input": typed}));
    assert_eq!(out["body"]["status"], "ok", "{out}");
    assert!(!out.to_string().contains(ADD_MARK), "the preview must not echo the typed address: {out}");
    let saved = w.call(a, "POST", "/sources", json!({"confirmationId": out["body"]["confirmationId"]}));
    assert_eq!(saved["status"], 201, "{saved}");
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') \
                 OR table_name LIKE 'news\\_%'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    for table in &tables {
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE lower(to_jsonb(t)::text) LIKE '%'||lower($1)||'%'"), &[&ADD_MARK])).unwrap().get(0);
        // The saved source keeps the person's own feed address in their own row, and nowhere else.
        let allowed = i64::from(table == "app.news_custom_sources");
        assert!(hits <= allowed, "{table} holds typed text");
        if table == "app.news_custom_sources" {
            assert_eq!(hits, 1, "the saved source should hold the address it was given");
        }
    }
    println!("PASS privacy: scanned {} tables, the typed address is only in the saved source row", tables.len());
}
