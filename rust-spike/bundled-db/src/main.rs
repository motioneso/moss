//! `moss-db`: starts, migrates, watches and stops one install's private database.
//!
//! Every command prints JSON on stdout, one event per line for `up`, so a parent program (the
//! app, or a proof script) can follow along without parsing log text.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use bundled_db::cluster::{self, Bundle, Endpoint, Listen, StopMode};
use bundled_db::layout::Layout;
use bundled_db::{at_rest, migrate, procs, secrets, APP_DATABASE, SUPERUSER};
use serde_json::{json, Value};
use signal_hook::consts::{SIGCHLD, SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

const USAGE: &str = "\
usage:
  moss-db init    --root DIR --pg DIR
  moss-db up      --root DIR --pg DIR --repo DIR [--tcp] [--port-range FIRST-LAST]
  moss-db stop    --root DIR
  moss-db status  --root DIR
  moss-db check   --root DIR [--write NOTE]
  moss-db hold    --root DIR --seconds N
  moss-db at-rest [--root DIR] [--path LABEL=DIR]...
";

/// `up` exits with this code when Postgres stops without being asked.
const DATABASE_EXITED: u8 = 3;

const START_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a fast shutdown may take before the supervisor escalates.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

const PROOF_DATABASE: &str = "moss_proof";

fn main() -> ExitCode {
    if let Err(error) = procs::protect_from_crash_dumps() {
        emit(&json!({ "event": "error", "error": format!("crash-dump protection: {error}") }));
        return ExitCode::FAILURE;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };
    let options = match Options::parse(rest) {
        Ok(options) => options,
        Err(error) => {
            eprint!("{error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let result = match command.as_str() {
        "init" => init(&options),
        "up" => up(&options),
        "stop" => stop(&options),
        "status" => status(&options),
        "check" => check(&options),
        "hold" => hold(&options),
        "at-rest" => at_rest_report(&options),
        _ => {
            eprint!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    result.unwrap_or_else(|error| {
        emit(&json!({ "event": "error", "error": error }));
        ExitCode::FAILURE
    })
}

#[derive(Default)]
struct Options {
    root: Option<PathBuf>,
    pg: Option<PathBuf>,
    repo: Option<PathBuf>,
    tcp: bool,
    port_range: Option<(u16, u16)>,
    write: Option<String>,
    seconds: Option<u32>,
    paths: Vec<(String, PathBuf)>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Options, String> {
        let mut options = Options::default();
        let mut args = args.iter();
        while let Some(flag) = args.next() {
            let mut value = || args.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
            match flag.as_str() {
                "--root" => options.root = Some(value()?.into()),
                "--pg" => options.pg = Some(value()?.into()),
                "--repo" => options.repo = Some(value()?.into()),
                "--tcp" => options.tcp = true,
                "--port-range" => {
                    let text = value()?;
                    let range = text
                        .split_once('-')
                        .and_then(|(first, last)| Some((first.parse().ok()?, last.parse().ok()?)))
                        .filter(|(first, last): &(u16, u16)| first <= last && *first > 0)
                        .ok_or_else(|| format!("bad port range {text}"))?;
                    options.port_range = Some(range);
                }
                "--write" => options.write = Some(value()?),
                "--seconds" => options.seconds = Some(value()?.parse().map_err(|_| "--seconds needs a number")?),
                "--path" => {
                    let text = value()?;
                    let (label, path) = text.split_once('=').ok_or_else(|| format!("--path wants LABEL=DIR, got {text}"))?;
                    options.paths.push((label.to_string(), path.into()));
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        Ok(options)
    }

    fn root(&self) -> Result<&Path, String> {
        self.root.as_deref().ok_or_else(|| "--root is required".into())
    }

    fn bundle(&self) -> Result<Bundle, String> {
        Bundle::new(self.pg.as_deref().ok_or("--pg is required")?)
    }
}

fn init(options: &Options) -> Result<ExitCode, String> {
    let layout = Layout::create(options.root()?).map_err(|e| e.to_string())?;
    let _lock = cluster::lock(&layout)?;
    let bundle = options.bundle()?;
    let clock = Instant::now();
    let created = cluster::initialize(&layout, &bundle)?;
    emit(&json!({ "event": "initialized", "created": created, "ms": ms(clock) }));
    Ok(ExitCode::SUCCESS)
}

/// Lock, create on first run, start, migrate, then watch until asked to stop.
fn up(options: &Options) -> Result<ExitCode, String> {
    let layout = Layout::create(options.root()?).map_err(|e| e.to_string())?;
    let _lock = cluster::lock(&layout)?;
    let bundle = options.bundle()?;
    let repo = options.repo.as_deref().ok_or("--repo is required")?;
    let listen = if options.tcp || options.port_range.is_some() {
        Listen::Loopback(options.port_range)
    } else {
        Listen::SocketOnly
    };

    let clock = Instant::now();
    let created = cluster::initialize(&layout, &bundle)?;
    let initdb_ms = ms(clock);

    // Registered before Postgres starts: a stop request during start-up or migration waits
    // here and is acted on once the cluster can be stopped in order.
    let mut signals = Signals::new([SIGINT, SIGTERM, SIGHUP, SIGCHLD]).map_err(|e| e.to_string())?;

    let clock = Instant::now();
    let mut running = cluster::start(&layout, &bundle, &listen, START_TIMEOUT)?;
    let start_ms = ms(clock);

    let clock = Instant::now();
    let summary = match migrate::run(repo, &layout, &running.endpoint) {
        Ok(summary) => summary,
        Err(error) => {
            let stopped = cluster::stop(&layout, &mut running, STOP_TIMEOUT);
            emit(&json!({
                "event": "error",
                "error": format!("migrations: {error}"),
                "stopped": match stopped {
                    Ok((mode, status)) => format!("{} ({status})", mode_name(mode)),
                    Err(error) => error,
                },
            }));
            return Ok(ExitCode::FAILURE);
        }
    };
    let migrate_ms = ms(clock);

    emit(&json!({
        "event": "ready",
        "supervisor_pid": std::process::id(),
        "postgres_pid": running.pid,
        "endpoint": running.endpoint.to_json(),
        "created_cluster": created,
        "recovered": running.recovered,
        "skipped_ports": running.skipped_ports,
        "migrations": {
            "created_database": summary.created_database,
            "bootstrap_files": summary.bootstrap_files,
            "applied": summary.applied,
            "already_applied": summary.skipped,
            "backfills_on_empty_tables": summary.backfills_on_empty_tables,
        },
        "ms": { "initdb": initdb_ms, "start": start_ms, "migrate": migrate_ms },
    }));

    for signal in signals.forever() {
        if signal == SIGCHLD {
            // Any child ending raises this; only the database's own exit matters.
            if let Ok(Some(status)) = running.child.try_wait() {
                let _ = std::fs::remove_file(layout.state_file());
                emit(&json!({ "event": "database-exited", "status": status.to_string() }));
                return Ok(ExitCode::from(DATABASE_EXITED));
            }
            continue;
        }
        let clock = Instant::now();
        let (mode, status) = cluster::stop(&layout, &mut running, STOP_TIMEOUT)?;
        emit(&json!({
            "event": "stopped",
            "signal": signal_name(signal),
            "mode": mode_name(mode),
            "status": status.to_string(),
            "ms": ms(clock),
        }));
        return Ok(ExitCode::SUCCESS);
    }
    Err("signal loop ended".into())
}

/// Asks the running supervisor to stop, then waits until it has let go of the install.
fn stop(options: &Options) -> Result<ExitCode, String> {
    let layout = Layout::open(options.root()?).map_err(|e| e.to_string())?;
    let Some(pid) = cluster::holder(&layout)? else {
        emit(&json!({ "event": "not-running" }));
        return Ok(ExitCode::SUCCESS);
    };
    let clock = Instant::now();
    procs::signal(pid, libc::SIGTERM);
    while cluster::holder(&layout)?.is_some() {
        if clock.elapsed() > STOP_TIMEOUT + Duration::from_secs(30) {
            return Err(format!("supervisor {pid} is still running"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    emit(&json!({ "event": "stopped", "supervisor_pid": pid, "ms": ms(clock) }));
    Ok(ExitCode::SUCCESS)
}

fn status(options: &Options) -> Result<ExitCode, String> {
    let layout = Layout::open(options.root()?).map_err(|e| e.to_string())?;
    let supervisor = cluster::holder(&layout)?;
    let postmaster = cluster::read_postmaster_pid(&layout);
    let state = cluster::read_state(&layout).ok();
    emit(&json!({
        "supervisor_pid": supervisor,
        "postgres": postmaster.map(|p| json!({ "pid": p.pid, "status": p.status, "alive": procs::alive(p.pid) })),
        "endpoint": state.as_ref().map(|s| s["endpoint"].clone()),
    }));
    Ok(ExitCode::SUCCESS)
}

/// Reads back what `up` set up, and runs a vector search. `--write NOTE` also stores a
/// marked row, so a later check after a restart or a crash can show the row survived.
fn check(options: &Options) -> Result<ExitCode, String> {
    let layout = Layout::open(options.root()?).map_err(|e| e.to_string())?;
    let state = cluster::read_state(&layout)?;
    let endpoint = Endpoint::from_json(&state["endpoint"], &layout.run).ok_or("the state file has no endpoint")?;
    let superuser = secrets::existing(&layout, SUPERUSER)?;
    let sql = |e: postgres::Error| cluster::db_error(&e);

    let mut app = endpoint.connect(SUPERUSER, &superuser, APP_DATABASE)?;
    let server = app
        .query_one(
            "SELECT current_setting('server_version'), pg_postmaster_start_time()::text, current_setting('data_checksums'), \
             current_setting('cluster_name'), current_setting('shared_preload_libraries')",
            &[],
        )
        .map_err(sql)?;
    let vector: Option<String> = app
        .query_opt("SELECT extversion FROM pg_extension WHERE extname = 'vector'", &[])
        .map_err(sql)?
        .map(|row| row.get(0));
    let vector_columns: i64 = app
        .query_one("SELECT count(*) FROM information_schema.columns WHERE udt_name = 'vector'", &[])
        .map_err(sql)?
        .get(0);
    let migrations: i64 = app.query_one("SELECT count(*) FROM app.schema_migrations", &[]).map_err(sql)?.get(0);

    // The app's runtime role signs in with its own password and has no special powers.
    let runtime = secrets::existing(&layout, "jarvis_app_runtime")?;
    let mut as_runtime = endpoint.connect("jarvis_app_runtime", &runtime, APP_DATABASE)?;
    let role = as_runtime
        .query_one("SELECT current_user::text, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user", &[])
        .map_err(sql)?;

    let mut maintenance = endpoint.connect(SUPERUSER, &superuser, "postgres")?;
    let has_proof = maintenance
        .query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&PROOF_DATABASE])
        .map_err(sql)?
        .is_some();
    if !has_proof && options.write.is_some() {
        maintenance.batch_execute(&format!("CREATE DATABASE {PROOF_DATABASE}")).map_err(sql)?;
    }
    let proof = if has_proof || options.write.is_some() {
        Some(vector_proof(&endpoint, &superuser, options.write.as_deref())?)
    } else {
        None
    };

    emit_pretty(&json!({
        "server": {
            "version": server.get::<_, String>(0),
            "started": server.get::<_, String>(1),
            "data_checksums": server.get::<_, String>(2),
            "cluster_name": server.get::<_, String>(3),
            "shared_preload_libraries": server.get::<_, String>(4),
        },
        "app_database": {
            "vector_extension": vector,
            "vector_columns": vector_columns,
            "migrations_recorded": migrations,
        },
        "runtime_role": {
            "name": role.get::<_, String>(0),
            "superuser": role.get::<_, bool>(1),
            "bypasses_row_security": role.get::<_, bool>(2),
        },
        "proof_database": proof,
    }));
    Ok(ExitCode::SUCCESS)
}

fn vector_proof(endpoint: &Endpoint, superuser: &secrets::Secret, note: Option<&str>) -> Result<Value, String> {
    let sql = |e: postgres::Error| cluster::db_error(&e);
    let mut db = endpoint.connect(SUPERUSER, superuser, PROOF_DATABASE)?;
    db.batch_execute(
        "CREATE EXTENSION IF NOT EXISTS vector;
         CREATE TABLE IF NOT EXISTS items (id int PRIMARY KEY, label text NOT NULL, embedding vector(3) NOT NULL);
         INSERT INTO items VALUES
           (1, 'east', '[1,0,0]'), (2, 'north', '[0,1,0]'), (3, 'up', '[0,0,1]'), (4, 'north-east', '[0.7,0.7,0]')
           ON CONFLICT (id) DO NOTHING;
         CREATE INDEX IF NOT EXISTS items_embedding ON items USING hnsw (embedding vector_l2_ops);
         CREATE TABLE IF NOT EXISTS marks (id bigserial PRIMARY KEY, note text NOT NULL, written_at timestamptz NOT NULL DEFAULT now());",
    )
    .map_err(sql)?;
    if let Some(note) = note {
        db.execute("INSERT INTO marks (note) VALUES ($1)", &[&note]).map_err(sql)?;
    }
    let query = "[0.9,0.6,0]";
    let nearest: Vec<Value> = db
        .query(
            "SELECT label, round((embedding <-> $1::text::vector)::numeric, 4)::text FROM items
             ORDER BY embedding <-> $1::text::vector LIMIT 2",
            &[&query],
        )
        .map_err(sql)?
        .iter()
        .map(|row| json!({ "label": row.get::<_, String>(0), "distance": row.get::<_, String>(1) }))
        .collect();
    // Too few rows for the planner to choose the index on cost, so sequential scans are off
    // for this one plan to show the HNSW index can serve the search.
    let mut tx = db.transaction().map_err(sql)?;
    tx.batch_execute("SET LOCAL enable_seqscan = off").map_err(sql)?;
    let plan: Vec<String> = tx
        .query("EXPLAIN (COSTS OFF) SELECT id FROM items ORDER BY embedding <-> $1::text::vector LIMIT 2", &[&query])
        .map_err(sql)?
        .iter()
        .map(|row| row.get(0))
        .collect();
    tx.commit().map_err(sql)?;
    let marks: Vec<Value> = db
        .query("SELECT id, note, written_at::text FROM marks ORDER BY id", &[])
        .map_err(sql)?
        .iter()
        .map(|row| json!({ "id": row.get::<_, i64>(0), "note": row.get::<_, String>(1), "written_at": row.get::<_, String>(2) }))
        .collect();
    Ok(json!({ "query": query, "nearest": nearest, "plan": plan, "marks": marks }))
}

/// Proof helper: one session reads the proof rows into memory, then keeps the CPU busy. It
/// prints the server process id first, so a crash proof can target that exact process. A busy
/// loop, unlike `pg_sleep`, does not notice the postmaster dying, which the leftover proof needs.
fn hold(options: &Options) -> Result<ExitCode, String> {
    let seconds = options.seconds.ok_or("give --seconds")?;
    let layout = Layout::open(options.root()?).map_err(|e| e.to_string())?;
    let state = cluster::read_state(&layout)?;
    let endpoint = Endpoint::from_json(&state["endpoint"], &layout.run).ok_or("the state file has no endpoint")?;
    let superuser = secrets::existing(&layout, SUPERUSER)?;
    let sql = |e: postgres::Error| cluster::db_error(&e);
    let mut db = endpoint.connect(SUPERUSER, &superuser, PROOF_DATABASE)?;
    let row = db.query_one("SELECT pg_backend_pid(), count(*) FROM marks", &[]).map_err(sql)?;
    emit(&json!({ "event": "holding", "backend_pid": row.get::<_, i32>(0), "rows_read": row.get::<_, i64>(1) }));
    let busy = format!(
        "DO $$ BEGIN WHILE clock_timestamp() < now() + interval '{seconds} seconds' LOOP END LOOP; END $$"
    );
    let outcome = match db.batch_execute(&busy) {
        Ok(()) => "finished".to_string(),
        Err(error) => sql(error),
    };
    emit(&json!({ "event": "released", "outcome": outcome }));
    Ok(ExitCode::SUCCESS)
}

/// Disk encryption for the install's folders (with `--root`), any `--path`, swap and crash
/// dumps. Reads only; creates nothing.
fn at_rest_report(options: &Options) -> Result<ExitCode, String> {
    let mut paths = Vec::new();
    let mut supervisor = Ok(None);
    let mut database_pids = Vec::new();
    if let Some(root) = &options.root {
        paths.push(("Database folder".to_string(), root.join("db")));
        paths.push(("Logs".to_string(), root.join("logs")));
        // The same data path the supervisor uses, so the cluster name matches.
        if let Ok(layout) = Layout::open(root) {
            supervisor = cluster::holder(&layout);
            database_pids = procs::database_processes(&layout.data, &layout.cluster_name());
        }
    }
    paths.extend(options.paths.iter().cloned());
    if paths.is_empty() {
        return Err("give --root or at least one --path".into());
    }
    #[cfg(target_os = "linux")]
    let report = at_rest::linux::report(&paths, supervisor, &database_pids);
    #[cfg(target_os = "macos")]
    let report = {
        let _ = (supervisor, database_pids);
        at_rest::macos::report(&paths)
    };
    emit_pretty(&report.to_json());
    Ok(ExitCode::SUCCESS)
}

fn mode_name(mode: StopMode) -> &'static str {
    match mode {
        StopMode::AlreadyExited => "already-exited",
        StopMode::Clean => "clean",
        StopMode::Immediate => "immediate",
        StopMode::Killed => "killed",
    }
}

fn signal_name(signal: i32) -> &'static str {
    match signal {
        SIGINT => "SIGINT",
        SIGTERM => "SIGTERM",
        SIGHUP => "SIGHUP",
        _ => "other",
    }
}

fn ms(clock: Instant) -> u64 {
    clock.elapsed().as_millis() as u64
}

fn emit(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn emit_pretty(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", serde_json::to_string_pretty(value).unwrap_or_default());
    let _ = out.flush();
}
