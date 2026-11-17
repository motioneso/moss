//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use access_context::AccessContext;
use moss_module_host::{
    account_preferences::{AccountPreferencesPorts, Binding, JsonShape},
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Host, Limits, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-4f1c9b";

/// Sports never asks the router, so any request fails loudly.
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Sports does not use the AI service")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Sports does not use the AI service")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("SPORTS_COMPONENT_WASM")
            .expect("Run modules/sports/tools/check.sh to build the component"),
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

/// The two saved-setting keys the shell grants Sports, bound the same way here.
fn preferences(db: safety_core::db::Database, next: Arc<dyn moss_module_host::runtime::Ports>) -> anyhow::Result<AccountPreferencesPorts> {
    AccountPreferencesPorts::new(
        db,
        std::collections::BTreeMap::from([
            (
                ("sports".into(), "standings-competitions".into()),
                Binding::Json { key: "sports.standings_competition_keys".into(), shape: JsonShape::TextList { max_items: 64, max_len: 200 } },
            ),
            (
                ("sports".into(), "standings-last-viewed".into()),
                Binding::Json { key: "sports.standings_last_viewed".into(), shape: JsonShape::LastViewed },
            ),
        ]),
        next,
    )
}

/// One installed Sports package on a fresh database.
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
        let bytes = moss_sports_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let prefs_db = f.db.clone();
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(NoAi),
                version: "0.1.0".parse().unwrap(),
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
                browser_dir: None,
            },
            move |next| Ok(Arc::new(preferences(prefs_db, next)?)),
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "sports-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(self.f.access(actor), method, &format!("/api/m/sports{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    }
    /// Calls the package's public export entry as the actor.
    fn export(&self, actor: uuid::Uuid) -> Value {
        let manifest = moss_sports_host::package::manifest().unwrap();
        let payload = json!({"name":"collectSportsSourcesExportSection","parameters":{}}).to_string();
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
            AccessContext::new(actor, "sports-export"),
            ports,
            "api",
            &payload,
        );
        let answer: Value = serde_json::from_str(&out.expect("the export finished")).unwrap();
        assert!(answer.get("error").is_none(), "{answer}");
        answer["ok"].clone()
    }
    /// A saved source with one target and one coverage row, put in by SQL because a real save
    /// would reach the network.
    fn plant_source(&self, who: uuid::Uuid, domain: &str, label: &str) -> uuid::Uuid {
        self.f.rt.block_on(async {
            let id: uuid::Uuid = self
                .f
                .root
                .query_one(
                    "INSERT INTO app.sports_custom_sources(owner_user_id,label,canonical_domain,homepage_url,feed_url,retrieval_method,\
                     validation_fingerprint,validated_at,recipe_status,confirmed_fetch_hosts,authorization_confirmed_at) \
                     VALUES($1,$2,$3,'https://'||$3||'/','https://'||$3||'/feed.xml','feed','f',now(),'feed',ARRAY[$3],now()) RETURNING id",
                    &[&who, &label, &domain],
                )
                .await
                .unwrap()
                .get(0);
            self.f
                .root
                .execute(
                    "INSERT INTO app.sports_source_assignments(owner_user_id,source_id,sport_key,target_url,preview_status,health_state) \
                     VALUES($1,$2,'soccer','https://'||$3||'/feed.xml','verified','healthy')",
                    &[&who, &id, &domain],
                )
                .await
                .unwrap();
            id
        })
    }
    /// Runs a tool as the actor through the host's own tool service, the way chat reaches it.
    /// The host checks the account's approval first and answers an error when there is none.
    fn tool(&self, actor: uuid::Uuid, name: &str, parameters: Value) -> anyhow::Result<Value> {
        let probe = wat::parse_str(
            include_str!("../../../../rust-spike/module-host/sample/module.wat").replace("moss:module/kv@", "moss:module/tools@"),
        )
        .unwrap();
        let ports: Arc<dyn moss_module_host::runtime::Ports> = self.app.services.clone();
        let out = Host::new(Limits::default()).unwrap().call(
            &probe,
            Arc::new(moss_sports_host::package::manifest().unwrap()),
            AccessContext::new(actor, "sports-tool"),
            ports,
            "route",
            &json!({"operation":"run","resource":name,"parameters":{"parameters":parameters}}).to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
    /// The approval card for a change, built from stored records as the approval screen asks.
    fn card(&self, actor: uuid::Uuid, name: &str, parameters: &Value) -> Value {
        let out = self
            .app
            .installer
            .call(
                "sports",
                AccessContext::new(actor, "sports-card"),
                "api",
                &json!({"name":"prepareSportsSourceAction","parameters":{"tool":name,"inputJson":parameters.to_string()}}).to_string(),
            )
            .unwrap();
        serde_json::from_str::<Value>(&out).unwrap()["ok"].clone()
    }
    fn approve(&self, actor: uuid::Uuid, name: &str, parameters: &Value, version: &str) {
        self.app.services.approve_tool_at_version(&AccessContext::new(actor, "sports-approve"), "sports", name, parameters, version).unwrap();
    }
    fn source_rows(&self) -> i64 {
        self.f.rt.block_on(self.f.root.query_one("SELECT count(*) FROM app.sports_custom_sources", &[])).unwrap().get(0)
    }
    fn follow_rows(&self, who: uuid::Uuid) -> i64 {
        self.f.rt.block_on(self.f.root.query_one("SELECT count(*) FROM app.sports_follows WHERE owner_user_id=$1", &[&who])).unwrap().get(0)
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn whole_league_follows_never_repeat_and_the_old_sql_rules_hold() {
    let w = World::new();
    let a = w.f.a;
    let first = w.call(a, "POST", "/follows", json!({"competitionKey":"nfl"}));
    let again = w.call(a, "POST", "/follows", json!({"competitionKey":"nfl"}));
    assert_eq!(first["status"], 200, "{first}");
    assert!(first["body"]["follow"]["id"].is_string(), "{first}");
    assert_eq!(first["body"]["follow"]["id"], again["body"]["follow"]["id"], "a repeat returns the same follow");
    assert_eq!(w.follow_rows(a), 1);
    println!("PASS route: following the same league twice keeps one row");

    // The unique index from SQL 0186 refuses a second whole-league row, even from direct SQL.
    let dup = w.f.rt.block_on(w.f.root.execute(
        "INSERT INTO app.sports_follows(owner_user_id,competition_key,team_key) VALUES($1,'nfl',NULL)",
        &[&a],
    ));
    assert!(dup.is_err(), "the database must refuse a repeat whole-league row");
    println!("PASS sql 0186: the database itself refuses a repeat whole-league row");

    // SQL 0185 removes old repeats. Drop the index, plant repeats, run the real file, count what is left.
    let sql = std::fs::read_to_string(root().join("packages/sports/sql/0185_sports_whole_league_dedupe.sql")).unwrap();
    let index = std::fs::read_to_string(root().join("packages/sports/sql/0186_sports_whole_league_unique.sql")).unwrap();
    w.f.rt.block_on(async {
        w.f.root.batch_execute("DROP INDEX app.sports_follows_whole_league_unique_idx").await.unwrap();
        for _ in 0..2 {
            w.f.root
                .execute("INSERT INTO app.sports_follows(owner_user_id,competition_key,team_key) VALUES($1,'nfl',NULL)", &[&a])
                .await
                .unwrap();
        }
    });
    assert_eq!(w.follow_rows(a), 3);
    w.f.rt.block_on(w.f.root.batch_execute(&sql)).unwrap();
    assert_eq!(w.follow_rows(a), 1, "the dedupe keeps one row");
    w.f.rt.block_on(w.f.root.batch_execute(&index)).unwrap();
    println!("PASS sql 0185: three repeats collapse to one, and 0186 restores the index");

    // With no team list the team follow is refused, and nothing is stored.
    let team = w.call(a, "POST", "/follows", json!({"competitionKey":"nba","teamKey":"LAL"}));
    assert_eq!((team["status"].as_u64(), team["body"]["error"].as_str()), (Some(400), Some("Unknown team: LAL")), "{team}");
    assert_eq!(w.follow_rows(a), 1);
    println!("PASS outage: with no team list a team follow is refused and nothing is stored");
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_see_change_or_remove_a_follow_and_the_check_fails_without_row_security() {
    let w = World::new();
    let (a, b, admin) = (w.f.a, w.f.b, w.f.admin);
    let mine = w.call(a, "POST", "/follows", json!({"competitionKey":"nfl"}));
    let id = mine["body"]["follow"]["id"].as_str().unwrap_or_else(|| panic!("follow answer: {mine}")).to_owned();
    w.call(a, "PUT", "/standings-preferences", json!({"selectedCompetitionKeys":["nba"]}));

    assert_eq!(w.call(b, "GET", "/follows", Value::Null)["body"], json!({"follows":[]}));
    assert_eq!(w.call(admin, "GET", "/follows", Value::Null)["body"], json!({"follows":[]}), "an admin is just another person here");
    assert_eq!(w.call(b, "DELETE", &format!("/follows/{id}"), Value::Null)["body"], json!({"ok":false}));
    assert_eq!(w.call(b, "POST", &format!("/follows/{id}/team"), json!({"sourceTeamId":"lal"}))["status"], 404);
    assert_eq!(w.call(b, "GET", "/standings-preferences", Value::Null)["body"]["selectedCompetitionKeys"], Value::Null);
    assert_eq!(w.follow_rows(a), 1, "A's follow survived B's delete");
    let count_for = |who| -> i64 { rows_as(&w.f, who, "SELECT count(*) FROM app.sports_follows", &[])[0].get(0) };
    assert_eq!((count_for(a), count_for(b), count_for(admin)), (1, 0, 0));
    println!("GREEN: B and an admin see no follows, cannot delete or change A's, and read no choices");

    // With row security removed the same direct read leaks A's follow to B.
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.sports_follows DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = count_for(b);
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.sports_follows ENABLE ROW LEVEL SECURITY; ALTER TABLE app.sports_follows FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(open, 1, "RED expected: B sees A's follow with row security removed, got {open}");
    println!("RED: with row security removed B sees A's follow");
    assert_eq!(count_for(b), 0, "restored");
    println!("GREEN: row security restored, B sees nothing again");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_overview_shows_each_person_only_their_own_clubs_and_leaks_without_row_security() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let add = |who: uuid::Uuid, competition: &str, key: &str, id: &str| {
        w.f.rt
            .block_on(w.f.root.execute(
                "INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key, source_team_id) VALUES ($1,$2,$3,$4)",
                &[&who, &competition, &key, &id],
            ))
            .unwrap();
    };
    add(a, "eng.1", "EVE", "368");
    add(b, "nhl", "BOS", "1");
    let names = |who: uuid::Uuid| -> Vec<String> {
        let out = w.call(who, "GET", "/overview", Value::Null);
        assert_eq!(out["status"], 200, "{out}");
        out["body"]["followed"].as_array().unwrap().iter().map(|c| c["competitionKey"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(names(a), vec!["eng.1"]);
    assert_eq!(names(b), vec!["nhl"]);
    println!("GREEN: each person's overview holds only their own club");

    // With row security removed the same read hands B both clubs.
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.sports_follows DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = names(b);
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.sports_follows ENABLE ROW LEVEL SECURITY; ALTER TABLE app.sports_follows FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(open.len(), 2, "RED expected: B sees A's club with row security removed, got {open:?}");
    println!("RED: with row security removed B's overview shows A's club");
    assert_eq!(names(b), vec!["nhl"], "restored");
    println!("GREEN: row security restored, B sees only their own club again");
}

#[test]
#[ignore = "Only through verify-gate"]
fn typed_text_reaches_no_other_table_and_the_export_holds_only_the_owner_rows() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let tail = format!("{MARK}-tail");
    for body in [json!({"competitionKey":MARK}), json!({"competitionKey":"nba","teamKey":MARK})] {
        let out = w.call(a, "POST", "/follows", body);
        assert_eq!(out["status"], 400, "{out}");
    }
    w.call(a, "POST", "/follows", json!({"competitionKey":"nfl"}));
    let bad = w.call(a, "PUT", "/standings-preferences", json!({"lastViewed":{"competitionKey":tail,"viewKey":MARK}}));
    assert!(bad["status"].as_u64().unwrap() < 500, "{bad}");
    w.call(b, "POST", "/follows", json!({"competitionKey":"nhl"}));

    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') \
                 OR table_name LIKE 'sports\\_%'",
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
        let hits: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"), &[&MARK])).unwrap().get(0);
        assert_eq!(hits, 0, "{table} holds typed text");
    }
    println!("PASS privacy: scanned {} tables, the planted text is in none", tables.len());

    let export = w.export(a);
    assert_eq!(export["follows"].as_array().unwrap().len(), 1);
    assert_eq!(export["follows"][0]["competitionKey"], "nfl");
    for key in ["assignments", "espnAssignments", "headlinePreferences", "sources"] {
        assert!(export[key].is_array(), "{key} missing from the export: {export}");
    }
    assert!(!export.to_string().contains("nhl"), "B's follow must not be in A's export");
    println!("PASS export: A's export holds A's follow only, all five sections present");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_installed_routes_answer_like_the_old_routes_step_for_step() {
    let w = World::new();
    // The old server runs for its own person so the two sides never share rows.
    let old_actor = w.f.b;
    let mut before = replay::steps_before_ids();
    let old = replay::old_routes(old_actor, &before, json!({}));
    let mut new = Vec::new();
    for step in &before {
        let url = step["url"].as_str().unwrap().replace("/api/sports", "");
        let method = step["method"].as_str().unwrap();
        new.push(w.call(w.f.a, method, &url, step.get("body").cloned().unwrap_or(Value::Null)));
    }
    compare(&before, &old, &new);
    before.clear();

    // Steps that name a follow need the id each side made.
    let whole_old = old[2]["body"]["follow"]["id"].as_str().unwrap().to_owned();
    let whole_new = new[2]["body"]["follow"]["id"].as_str().unwrap().to_owned();
    let steps = replay::steps_with_ids();
    // The old side already holds one repeat whole-league follow per league, so the follow ids are looked up fresh.
    let old2 = replay::old_routes(old_actor, &steps, json!({"whole": whole_old}));
    let new2: Vec<Value> = steps
        .iter()
        .map(|s| {
            let url = replay::fill(s["url"].as_str().unwrap(), &json!({"whole": whole_new})).replace("/api/sports", "");
            w.call(w.f.a, s["method"].as_str().unwrap(), &url, s.get("body").cloned().unwrap_or(Value::Null))
        })
        .collect();
    compare(&steps, &old2, &new2);
    println!("PASS parity: {} steps matched the old routes", old.len() + old2.len());

    // The old route answers 500 for every bad standings request. The new route says what was wrong.
    for (body, words) in [
        (json!({"selectedCompetitionKeys":"nba"}), "Invalid standings competition keys"),
        (json!({"selectedCompetitionKeys":["zzz"]}), "Standings preferences contain an unknown competition"),
        (json!({"other":1}), "Invalid standings preferences"),
    ] {
        let out = w.call(w.f.a, "PUT", "/standings-preferences", body);
        assert_eq!((out["status"].as_u64(), out["body"]["error"].as_str()), (Some(400), Some(words)), "{out}");
    }
    println!("PASS deliberate fix: bad standings requests answer 400 with the intended words, not 500");
}

fn compare(steps: &[Value], old: &[Value], new: &[Value]) {
    assert_eq!(old.len(), new.len());
    for (i, ((step, o), n)) in steps.iter().zip(old).zip(new).enumerate() {
        let (mut o, mut n) = (o.clone(), n.clone());
        replay::mask(&mut o);
        replay::mask(&mut n);
        assert_eq!(o, n, "step {i} {} {} differs\nold: {o}\nnew: {n}", step["method"], step["url"]);
    }
}

/// The old route saves all ESPN coverage rows in one statement, so their order is by chance. Both
/// sides are put in the same order before comparing.
fn sort_builtin_targets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.get("kind").and_then(Value::as_str) == Some("builtin") {
                if let Some(Value::Array(items)) = map.get_mut("assignments") {
                    items.sort_by_key(|item| item.to_string());
                }
            }
            map.values_mut().for_each(sort_builtin_targets);
        }
        Value::Array(items) => items.iter_mut().for_each(sort_builtin_targets),
        _ => {}
    }
}

/// Like `compare`, but a 400 whose old words come from the schema checker's choice between target
/// shapes only has to match on status, because that checker lists every shape it tried.
fn compare_sources(steps: &[Value], old: &[Value], new: &[Value]) -> usize {
    assert_eq!(old.len(), new.len());
    let mut loose = 0;
    for (i, ((step, o), n)) in steps.iter().zip(old).zip(new).enumerate() {
        let (mut o, mut n) = (o.clone(), n.clone());
        replay::mask(&mut o);
        replay::mask(&mut n);
        sort_builtin_targets(&mut o);
        sort_builtin_targets(&mut n);
        let choice = o["status"] == 400 && o["body"]["error"].as_str().is_some_and(|t| t.contains("oneOf"));
        if choice && n["status"] == 400 {
            loose += 1;
            continue;
        }
        assert_eq!(o, n, "step {i} {} {} differs\nold: {o}\nnew: {n}", step["method"], step["url"]);
    }
    loose
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_see_change_or_remove_an_added_source_and_the_check_fails_without_row_security() {
    let w = World::new();
    let (a, b, admin) = (w.f.a, w.f.b, w.f.admin);
    let id = w.plant_source(a, "news.example.com", "Example Daily").to_string();
    let put = w.call(a, "PUT", "/sources/espn/coverage", json!({"assignments":[{"kind":"sport","sportKey":"soccer"}]}));
    assert_eq!(put["status"], 200, "{put}");
    let custom = |who| -> usize {
        let out = w.call(who, "GET", "/sources", Value::Null);
        assert_eq!(out["status"], 200, "{out}");
        out["body"]["sources"].as_array().unwrap().iter().filter(|s| s["kind"] == "custom").count()
    };
    assert_eq!((custom(a), custom(b), custom(admin)), (1, 0, 0));
    let theirs = w.call(b, "GET", "/sources", Value::Null);
    assert_eq!(theirs["body"]["sources"][0]["usesDefaultCoverage"], true, "B sees the default coverage, not A's choice");
    assert_eq!(w.call(b, "DELETE", &format!("/sources/{id}"), Value::Null)["body"], json!({"deleted":false}));
    assert_eq!(w.call(b, "POST", &format!("/sources/{id}/assignments/preview"), json!({"assignments":[]}))["status"], 404);
    let icon = w.call(b, "GET", &format!("/sources/{id}/icon"), Value::Null);
    assert_eq!((icon["status"].as_u64(), icon["body"]["error"].as_str()), (Some(404), Some("Sports source not found")));
    assert_eq!(custom(a), 1, "A's source survived B's delete");
    let tables = [
        "app.sports_custom_sources",
        "app.sports_source_assignments",
        "app.sports_espn_source_assignments",
        "app.sports_headline_prefs",
    ];
    let count = |who, table: &str| -> i64 { rows_as(&w.f, who, &format!("SELECT count(*) FROM {table}"), &[])[0].get(0) };
    for table in tables {
        assert_eq!((count(a, table), count(b, table), count(admin, table)), (1, 0, 0), "{table}");
    }
    println!("GREEN: B and an admin see none of A's sources, targets or coverage and cannot delete or change them");

    // With row security removed on each table, B reads A's row. Each table is restored after.
    for table in tables {
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let open = count(b, table);
        w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
        assert_eq!(open, 1, "RED expected: B sees A's row in {table} with row security removed, got {open}");
        assert_eq!(count(b, table), 0, "{table} restored");
    }
    println!("RED: with row security removed B reads A's row in each of the four tables, and it is restored after");
}

#[test]
#[ignore = "Only through verify-gate"]
fn typed_source_text_reaches_no_other_table_and_the_export_holds_only_the_owner_sources() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let host = format!("{}.example.com", MARK.to_lowercase());
    let body_marked = format!("{MARK}-body");
    // None of these saves anything: the address cannot be reached, or the text is refused.
    for body in [
        json!({"url":host}),
        json!({"url":format!("r/{MARK}")}),
        json!({"url":MARK,"extra":body_marked}),
        json!({"url":"news.example.com","assignments":[{"target":{"kind":"sport","sportKey":MARK}}]}),
    ] {
        let out = w.call(a, "POST", "/sources/preview", body);
        assert!(out["status"].as_u64().unwrap() < 500, "{out}");
        assert_ne!(out["body"]["status"], "ok", "{out}");
    }
    let confirm = json!({"confirmationId":MARK,"authorizationAcknowledgement":MARK,"canonicalDomain":MARK,"confirmedFetchHosts":[MARK],"targets":[]});
    assert!(w.call(a, "POST", "/sources", confirm.clone())["status"].as_u64().unwrap() < 500);
    let planted = w.plant_source(a, "news.example.com", "Example Daily").to_string();
    w.call(b, "PATCH", &format!("/sources/{planted}/assignments"), confirm);
    w.call(a, "PUT", "/sources/espn/coverage", json!({"assignments":[{"kind":"sport","sportKey":MARK}]}));

    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') \
                 OR table_name LIKE 'sports\\_%'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")) && tables.iter().any(|t| t == "app.sports_custom_sources"), "{tables:?}");
    for table in &tables {
        let hits: i64 = w
            .f
            .rt
            .block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE lower(to_jsonb(t)::text) LIKE '%'||lower($1)||'%'"), &[&MARK]))
            .unwrap()
            .get(0);
        assert_eq!(hits, 0, "{table} holds typed text");
    }
    println!("PASS privacy: scanned {} tables, the planted source text is in none", tables.len());

    let export = w.export(a);
    assert_eq!(export["sources"].as_array().unwrap().len(), 1, "{export}");
    assert!(!w.export(b).to_string().contains("example.com"), "B's export holds none of A's sources");
    println!("PASS export: A's export holds A's source only");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_installed_source_routes_answer_like_the_old_routes_step_for_step() {
    let w = World::new();
    let steps = replay::steps_sources();
    let old = replay::old_routes(w.f.b, &steps, json!({}));
    let new: Vec<Value> = steps
        .iter()
        .map(|s| {
            let url = s["url"].as_str().unwrap().replace("/api/sports", "");
            w.call(w.f.a, s["method"].as_str().unwrap(), &url, s.get("body").cloned().unwrap_or(Value::Null))
        })
        .collect();
    let loose = compare_sources(&steps, &old, &new);
    println!("PASS parity: {} source steps matched the old routes ({loose} matched on status only)", steps.len());

    // The old route answers 500 when the id is not a UUID. The new route says the source is not found.
    let icon = w.call(w.f.a, "GET", "/sources/not-a-uuid/icon", Value::Null);
    assert_eq!((icon["status"].as_u64(), icon["body"]["error"].as_str()), (Some(404), Some("Sports source not found")), "{icon}");
    println!("PASS deliberate fix: an icon request with a bad id answers 404, not 500");
}

#[test]
#[ignore = "Only through verify-gate"]
fn removing_a_source_asks_first_and_another_person_cannot_use_the_card_and_it_fails_without_row_security() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let id = w.plant_source(a, "news.example.com", "Example Daily").to_string();
    let input = json!({"sourceId":id});
    // The card is read from the saved row.
    let card = w.card(a, "sports.removeSource", &input);
    assert_eq!(card["title"], "Remove sports news source", "{card}");
    assert!(card["fields"].to_string().contains("Example Daily"), "{card}");
    // No approval: the host refuses and the row stays.
    assert!(w.tool(a, "sports.removeSource", input.clone()).is_err(), "no approval, no removal");
    assert_eq!(w.source_rows(), 1);
    // An old version is refused by the tool and the row stays.
    w.approve(a, "sports.removeSource", &input, "an-old-version");
    let stale = w.tool(a, "sports.removeSource", input.clone()).unwrap();
    assert!(stale["data"]["error"].as_str().is_some_and(|e| e.contains("approval no longer matches")), "{stale}");
    assert_eq!(w.source_rows(), 1);
    // B has no card for A's source and cannot remove it even with an approval of their own.
    assert_eq!(w.card(b, "sports.removeSource", &input), Value::Null);
    w.approve(b, "sports.removeSource", &input, "guess");
    let theirs = w.tool(b, "sports.removeSource", input.clone()).unwrap();
    assert!(theirs["data"]["error"].is_string(), "{theirs}");
    assert_eq!(w.source_rows(), 1, "A's source survived B");
    let listed = w.tool(b, "sports.listSources", json!({}));
    if let Ok(listed) = &listed {
        assert!(!listed.to_string().contains("news.example.com"), "{listed}");
    }
    println!("GREEN: removeSource asks first, refuses an old version, and B cannot see or remove A's source");
    // With row security removed, B's card for A's source is built, so the protection is what stops it.
    let table = "app.sports_custom_sources";
    w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
    let open = w.card(b, "sports.removeSource", &input);
    w.f.rt.block_on(w.f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))).unwrap();
    assert!(open["title"].is_string(), "RED expected: B gets A's card with row security removed, got {open}");
    assert_eq!(w.card(b, "sports.removeSource", &input), Value::Null, "restored");
    println!("RED: with row security removed B is shown A's source on a removal card, and it is restored after");
    // The real approval, shown and consumed once, removes the row.
    let version = card["version"].as_str().unwrap();
    w.approve(a, "sports.removeSource", &input, version);
    let done = w.tool(a, "sports.removeSource", input.clone()).unwrap();
    assert_eq!(done["data"]["removed"], true, "{done}");
    assert_eq!(w.source_rows(), 0);
    assert!(w.tool(a, "sports.removeSource", input).is_err(), "an approval is used once");
    println!("PASS: the approved removal deleted the row and the approval worked once");
}

#[test]
#[ignore = "Only through verify-gate"]
fn typed_tool_text_reaches_no_other_table() {
    let w = World::new();
    let a = w.f.a;
    let host = format!("{}.example.com", MARK.to_lowercase());
    for params in [
        json!({"url":host}),
        json!({"url":format!("r/{MARK}")}),
        json!({"url":"news.example.com","assignments":[{"target":{"kind":"sport","sportKey":MARK}}]}),
    ] {
        w.approve(a, "sports.previewSource", &params, "v");
        let out = w.tool(a, "sports.previewSource", params);
        assert!(out.is_ok(), "{out:?}");
    }
    let confirm = json!({"confirmationId":MARK,"authorizationAcknowledgement":MARK,"canonicalDomain":MARK,"confirmedFetchHosts":[MARK],"targets":[]});
    w.approve(a, "sports.confirmSource", &confirm, "v");
    let out = w.tool(a, "sports.confirmSource", confirm).unwrap();
    assert!(out["data"]["error"].is_string(), "{out}");
    let tables: Vec<String> = w.f.rt.block_on(async {
        w.f.root
            .query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') \
                 OR table_name IN ('notifications','moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log') \
                 OR table_name LIKE 'sports\\_%'",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    });
    for table in &tables {
        let hits: i64 = w
            .f
            .rt
            .block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} t WHERE lower(to_jsonb(t)::text) LIKE '%'||lower($1)||'%'"), &[&MARK]))
            .unwrap()
            .get(0);
        assert_eq!(hits, 0, "{table} holds typed tool text");
    }
    println!("PASS privacy: scanned {} tables after tool calls, the planted text is in none", tables.len());
}
