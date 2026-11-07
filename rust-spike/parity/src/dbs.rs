//! The two database copies: one for the TypeScript server, one for the Rust server.
//!
//! Both are cloned from the migrated gate database, so they start from the same schema the real
//! migrations built. Before each case both are reset to the integration tests' base seed.

use std::path::Path;

use serde_json::{json, Map, Value};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};
use url::Url;

/// The users, sessions and probe rows `seedProbeData` in `tests/integration/test-database.ts`
/// inserts after every reset.
const BASE_SEED: &str = "
INSERT INTO app.users (id, email, is_instance_admin) VALUES
  ('00000000-0000-4000-8000-000000000001', 'user-a@example.test', false),
  ('00000000-0000-4000-8000-000000000002', 'user-b@example.test', false),
  ('00000000-0000-4000-8000-000000000003', 'admin@example.test', true),
  ('00000000-0000-4000-8000-000000000091', 'user-c@example.test', false),
  ('00000000-0000-4000-8000-000000000092', 'user-d@example.test', false);
INSERT INTO app.auth_sessions (id, user_id, expires_at) VALUES
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', now() + interval '1 hour'),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', now() + interval '1 hour'),
  ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', now() + interval '1 hour');
INSERT INTO app.rls_probe_items (id, owner_user_id, body) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'user A private item'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'user B private item'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'user B item granted to user A'),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 'user B second private item');
";

/// Database URLs from the gate environment. Values are never printed.
pub struct GateEnv {
    pub gate_db: String,
    pub bootstrap: Url,
    pub app: Url,
    pub worker: Url,
    /// Every `*_DATABASE_URL` variable, so a server's whole environment can point at its copy.
    pub all: Vec<(String, Url)>,
}

impl GateEnv {
    pub fn from_env() -> Result<Self, String> {
        let read = |name: &str| -> Result<Url, String> {
            let text = std::env::var(name).map_err(|_| format!("{name} is not set"))?;
            Url::parse(&text).map_err(|_| format!("{name} is not a URL"))
        };
        let bootstrap = read("MOSS_BOOTSTRAP_DATABASE_URL")?;
        let gate_db = db_name(&bootstrap)?;
        let mut all = Vec::new();
        for (name, value) in std::env::vars() {
            if name.ends_with("_DATABASE_URL") {
                if let Ok(url) = Url::parse(&value) {
                    all.push((name, url));
                }
            }
        }
        Ok(GateEnv {
            gate_db,
            bootstrap,
            app: read("MOSS_APP_DATABASE_URL")?,
            worker: read("MOSS_WORKER_DATABASE_URL")?,
            all,
        })
    }

    /// Environment overrides that point every database variable at `db`.
    pub fn env_for(&self, db: &str) -> Vec<(String, String)> {
        let mut vars: Vec<(String, String)> = self
            .all
            .iter()
            .map(|(name, url)| (name.clone(), with_db(url, db).to_string()))
            .collect();
        for name in ["MOSS_PGDATABASE", "JARVIS_PGDATABASE"] {
            vars.push((name.to_owned(), db.to_owned()));
        }
        vars
    }
}

fn db_name(url: &Url) -> Result<String, String> {
    let name = url.path().trim_start_matches('/');
    if name.is_empty() {
        return Err("the bootstrap URL names no database".into());
    }
    Ok(name.to_owned())
}

/// A Postgres error with the server's message, code and detail, which plain Display hides.
pub fn pg(error: &tokio_postgres::Error) -> String {
    match error.as_db_error() {
        Some(db) => {
            let detail = db.detail().map(|text| format!(" ({text})")).unwrap_or_default();
            format!("{} [{}]{detail}", db.message(), db.code().code())
        }
        None => error.to_string(),
    }
}

pub fn with_db(url: &Url, db: &str) -> Url {
    let mut copy = url.clone();
    copy.set_path(&format!("/{db}"));
    copy
}

pub async fn connect(url: &Url) -> Result<Client, String> {
    let (client, connection) = tokio_postgres::connect(url.as_str(), NoTls)
        .await
        .map_err(|error| format!("connect: {}", pg(&error)))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

/// Rows from the `app.users` foreign-key closure that exist before any seed, kept so a reset can
/// put them back after `TRUNCATE ... CASCADE`.
struct Keep {
    table: String,
    columns: String,
}

pub struct Copy {
    pub name: String,
    admin: Client,
    keep: Vec<Keep>,
    truncate: Vec<String>,
    has_spike_jobs: bool,
}

pub struct Copies {
    pub ts: Copy,
    pub rs: Copy,
}

impl Copies {
    pub async fn create(env: &GateEnv, spike_sql: &Path) -> Result<Self, String> {
        let maintenance = connect(&with_db(&env.bootstrap, "postgres")).await?;
        let ts_name = "moss_parity_ts".to_owned();
        let rs_name = "moss_parity_rs".to_owned();
        // Separate statements, because a multi-statement batch runs as one transaction block and
        // DROP or CREATE DATABASE refuses to run inside one.
        for name in [&ts_name, &rs_name] {
            for sql in [
                format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"),
                format!("CREATE DATABASE \"{name}\" TEMPLATE \"{}\"", env.gate_db),
            ] {
                maintenance
                    .batch_execute(&sql)
                    .await
                    .map_err(|error| format!("clone {name}: {}", pg(&error)))?;
            }
        }
        let spike = std::fs::read_to_string(spike_sql)
            .map_err(|error| format!("read {}: {error}", spike_sql.display()))?;
        let ts = Copy::open(env, ts_name, None).await?;
        let rs = Copy::open(env, rs_name, Some(&spike)).await?;
        Ok(Copies { ts, rs })
    }

    pub async fn drop_all(self, env: &GateEnv) {
        let names = [self.ts.name.clone(), self.rs.name.clone()];
        drop(self);
        if let Ok(maintenance) = connect(&with_db(&env.bootstrap, "postgres")).await {
            for name in names {
                let _ = maintenance
                    .batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
                    .await;
            }
        }
    }
}

impl Copy {
    async fn open(env: &GateEnv, name: String, spike_sql: Option<&str>) -> Result<Self, String> {
        let admin = connect(&with_db(&env.bootstrap, &name)).await?;
        if let Some(sql) = spike_sql {
            admin.batch_execute(sql).await.map_err(|error| format!("spike SQL: {}", pg(&error)))?;
        }
        let closure = admin
            .query(
                "WITH RECURSIVE refs(tbl) AS ( \
                   SELECT 'app.users'::regclass \
                   UNION SELECT c.conrelid::regclass FROM pg_constraint c \
                   JOIN refs r ON c.confrelid = r.tbl WHERE c.contype = 'f') \
                 SELECT tbl::text FROM refs",
                &[],
            )
            .await
            .map_err(|error| format!("closure: {}", pg(&error)))?;
        admin
            .batch_execute("CREATE SCHEMA parity_keep")
            .await
            .map_err(|error| format!("keep schema: {}", pg(&error)))?;
        let mut keep = Vec::new();
        for row in closure {
            let table: String = row.get(0);
            let count: i64 = admin
                .query_one(&format!("SELECT count(*) FROM {table}"), &[])
                .await
                .map_err(|error| format!("count {table}: {}", pg(&error)))?
                .get(0);
            if count == 0 {
                continue;
            }
            let columns: String = admin
                .query_one(
                    "SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) \
                     FROM pg_attribute WHERE attrelid = $1::text::regclass \
                     AND attnum > 0 AND NOT attisdropped AND attgenerated = ''",
                    &[&table],
                )
                .await
                .map_err(|error| format!("columns {table}: {}", pg(&error)))?
                .get(0);
            let copy = keep_name(&table);
            admin
                .batch_execute(&format!("CREATE TABLE {copy} AS SELECT {columns} FROM {table}"))
                .await
                .map_err(|error| format!("keep {table}: {}", pg(&error)))?;
            keep.push(Keep { table, columns });
        }
        let mut truncate = Vec::new();
        for table in ["app.users", "pgboss.job", "pgboss.schedule", "spike_jobs.jobs"] {
            let exists: bool = admin
                .query_one("SELECT to_regclass($1) IS NOT NULL", &[&table])
                .await
                .map_err(|error| format!("check {table}: {}", pg(&error)))?
                .get(0);
            if exists {
                truncate.push(table.to_owned());
            }
        }
        let has_spike_jobs = spike_sql.is_some();
        Ok(Copy { name, admin, keep, truncate, has_spike_jobs })
    }

    /// Back to a freshly migrated database plus the base seed, then the case's own seed.
    pub async fn reset(&self, seed: &[String]) -> Result<(), String> {
        let mut sql = String::from("SET session_replication_role = replica;\n");
        sql.push_str(&format!("TRUNCATE {} CASCADE;\n", self.truncate.join(", ")));
        for keep in &self.keep {
            sql.push_str(&format!(
                "INSERT INTO {} ({cols}) OVERRIDING SYSTEM VALUE SELECT {cols} FROM {};\n",
                keep.table,
                keep_name(&keep.table),
                cols = keep.columns
            ));
        }
        sql.push_str("SET session_replication_role = DEFAULT;\n");
        sql.push_str(BASE_SEED);
        self.admin.batch_execute(&sql).await.map_err(|error| format!("reset: {}", pg(&error)))?;
        for statement in seed {
            self.admin
                .batch_execute(statement)
                .await
                .map_err(|error| format!("seed: {}", pg(&error)))?;
        }
        Ok(())
    }

    /// Every row of `table`, as JSON, read as the superuser.
    pub async fn rows(&self, table: &str) -> Result<Vec<Value>, String> {
        let row = self
            .admin
            .query_one(
                &format!("SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM {table} t"),
                &[],
            )
            .await
            .map_err(|error| format!("rows {table}: {}", pg(&error)))?;
        match row.get::<_, Value>(0) {
            Value::Array(rows) => Ok(rows),
            _ => Ok(Vec::new()),
        }
    }

    /// The finished state and output of a queued job, waiting up to 30 seconds for it.
    pub async fn job(&self, id: &str) -> Result<Value, String> {
        let table = if self.has_spike_jobs { "spike_jobs.jobs" } else { "pgboss.job" };
        let query = format!("SELECT state::text, output FROM {table} WHERE id = $1::text::uuid");
        for _ in 0..150 {
            let row = self
                .admin
                .query_opt(&query, &[&id])
                .await
                .map_err(|error| format!("job: {}", pg(&error)))?;
            if let Some(row) = row {
                let state: String = row.get(0);
                if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
                    let output: Option<Value> = row.get(1);
                    return Ok(json!({ "state": state, "output": output }));
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Ok(json!({ "state": "timed out" }))
    }
}

fn keep_name(table: &str) -> String {
    format!("parity_keep.\"{}\"", table.replace('"', ""))
}

fn probe_error(error: &tokio_postgres::Error) -> Value {
    let code = error.code().map(|code| code.code().to_owned());
    let message = error.as_db_error().map(|db| db.message().to_owned());
    json!({ "error": { "code": code, "message": message } })
}

/// Runs `sql` as a runtime role inside a transaction that is rolled back, with the actor set
/// the way the servers' data contexts set it. Returns `{rows}` or `{error}`.
pub async fn probe(role_url: &Url, db: &str, actor: Option<&str>, sql: &str) -> Value {
    let client = match connect(&with_db(role_url, db)).await {
        Ok(client) => client,
        Err(error) => return json!({ "error": { "connect": error } }),
    };
    let mut setup = String::from("BEGIN;");
    if let Some(actor) = actor {
        setup.push_str(&format!(
            "SELECT set_config('app.actor_user_id', '{actor}', true), \
                    set_config('app.request_id', 'parity', true);"
        ));
    }
    if let Err(error) = client.batch_execute(&setup).await {
        return json!({ "error": { "setup": error.to_string() } });
    }
    let statement = sql.trim().trim_end_matches(';');
    let is_select =
        statement.get(..6).is_some_and(|head| head.eq_ignore_ascii_case("select")) && !statement.contains(';');
    let result = if is_select {
        // A single SELECT keeps its column types by going through jsonb.
        let wrapped = format!("SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) FROM ({statement}) q");
        match client.query_one(&wrapped, &[]).await {
            Ok(row) => json!({ "rows": row.get::<_, Value>(0) }),
            Err(error) => probe_error(&error),
        }
    } else {
        // Anything else reports text rows and how many rows each statement touched.
        match client.simple_query(sql).await {
            Ok(messages) => {
                let mut rows = Vec::new();
                let mut affected = Vec::new();
                for message in &messages {
                    match message {
                        SimpleQueryMessage::Row(row) => {
                            let mut object = Map::new();
                            for (index, column) in row.columns().iter().enumerate() {
                                let value = row.get(index).map(|text| Value::String(text.to_owned()));
                                object.insert(column.name().to_owned(), value.unwrap_or(Value::Null));
                            }
                            rows.push(Value::Object(object));
                        }
                        SimpleQueryMessage::CommandComplete(count) => affected.push(json!(count)),
                        _ => {}
                    }
                }
                json!({ "rows": rows, "affected": affected })
            }
            Err(error) => probe_error(&error),
        }
    };
    let _ = client.batch_execute("ROLLBACK").await;
    result
}
