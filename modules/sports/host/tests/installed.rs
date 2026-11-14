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
