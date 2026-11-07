//! Differential checks for the Tasks module (Phase 0b, plan section 2.3).
//!
//! Sends the same requests to the TypeScript server and the Rust server, each on its own clone of
//! the gate database, and compares status, body, job results and the rows each case left behind.
//! Runs only inside a gate run.

mod canon;
mod case;
mod dbs;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::process::{Child, Command};

use canon::{contains, diff, Canon};
use case::{actor_token, actor_user, Case, Step, Vars};
use dbs::{Copies, Copy, GateEnv};

struct Args {
    repo: PathBuf,
    cases: PathBuf,
    report: PathBuf,
    logs: PathBuf,
    rs_bin: PathBuf,
    ts_port: u16,
    rs_port: u16,
    only: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut values: HashMap<String, String> = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let name = flag.strip_prefix("--").ok_or_else(|| format!("unexpected argument {flag}"))?;
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        values.insert(name.to_owned(), value);
    }
    let take = |name: &str| values.get(name).cloned().ok_or_else(|| format!("--{name} is required"));
    let port = |name: &str| -> Result<u16, String> {
        take(name)?.parse().map_err(|_| format!("--{name} must be a port number"))
    };
    Ok(Args {
        repo: take("repo")?.into(),
        cases: take("cases")?.into(),
        report: take("report")?.into(),
        logs: take("logs")?.into(),
        rs_bin: take("rs-bin")?.into(),
        ts_port: port("ts-port")?,
        rs_port: port("rs-port")?,
        only: values.get("only").cloned(),
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("parity: {error}");
            ExitCode::from(2)
        }
    }
}

async fn run() -> Result<bool, String> {
    if std::env::var("JARVIS_GATE_RUN").as_deref() != Ok("1") {
        return Err("refusing to run: JARVIS_GATE_RUN=1 is not set".into());
    }
    let args = parse_args()?;
    let env = GateEnv::from_env()?;
    let cases = case::load_dir(&args.cases, args.only.as_deref())?;
    std::fs::create_dir_all(&args.logs).map_err(|error| format!("logs: {error}"))?;

    let spike_sql = args.repo.join("rust-spike/tasks/sql/0001_spike_job_queue.sql");
    let copies = Copies::create(&env, &spike_sql).await?;
    let result = run_cases(&args, &env, &copies, &cases).await;
    copies.drop_all(&env).await;
    result
}

struct Server {
    name: &'static str,
    child: Child,
    base: String,
}

impl Server {
    async fn start(
        name: &'static str,
        mut command: Command,
        port: u16,
        env: &[(String, String)],
        log: PathBuf,
    ) -> Result<Self, String> {
        let file = std::fs::File::create(&log).map_err(|error| format!("log: {error}"))?;
        let err = file.try_clone().map_err(|error| format!("log: {error}"))?;
        command
            .envs(env.iter().cloned())
            .env("TASKS_SPIKE_PORT", port.to_string())
            .env("TZ", "America/Los_Angeles")
            .stdin(Stdio::null())
            .stdout(file)
            .stderr(err)
            .kill_on_drop(true);
        let child = command.spawn().map_err(|error| format!("start {name}: {error}"))?;
        let mut server = Server { name, child, base: format!("http://127.0.0.1:{port}") };
        server.wait_ready().await?;
        Ok(server)
    }

    /// Ready once any HTTP answer comes back.
    async fn wait_ready(&mut self) -> Result<(), String> {
        let client = reqwest::Client::new();
        for _ in 0..360 {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!("{} server exited early ({status}); see its log", self.name));
            }
            if client.get(format!("{}/api/tasks", self.base)).send().await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(format!("{} server did not answer within 90 seconds", self.name))
    }

    async fn stop(mut self) {
        if let Some(pid) = self.child.id() {
            let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status().await;
        }
        if tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
    }
}

#[derive(Serialize)]
struct Outcome {
    name: String,
    source: String,
    passed: bool,
    problems: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

async fn run_cases(
    args: &Args,
    env: &GateEnv,
    copies: &Copies,
    cases: &[Case],
) -> Result<bool, String> {
    let mut ts_command = Command::new(args.repo.join("node_modules/.bin/tsx"));
    ts_command
        .arg(args.repo.join("rust-spike/parity/ts-server.ts"))
        .current_dir(&args.repo)
        .env("NODE_ENV", "test")
        .env("JARVIS_EMBED_PROVIDER", "stub");
    let ts = Server::start(
        "TypeScript",
        ts_command,
        args.ts_port,
        &env.env_for(&copies.ts.name),
        args.logs.join("ts-server.log"),
    )
    .await?;
    let rs = match Server::start(
        "Rust",
        Command::new(&args.rs_bin),
        args.rs_port,
        &env.env_for(&copies.rs.name),
        args.logs.join("rs-server.log"),
    )
    .await
    {
        Ok(server) => server,
        Err(error) => {
            ts.stop().await;
            return Err(error);
        }
    };

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let mut outcomes = Vec::new();
    for case in cases {
        let outcome = run_case(case, env, copies, [&ts, &rs], &http).await;
        let mark = if outcome.passed { "PASS" } else { "FAIL" };
        println!("{mark} {}", outcome.name);
        for problem in &outcome.problems {
            println!("     {problem}");
        }
        outcomes.push(outcome);
    }
    ts.stop().await;
    rs.stop().await;

    let passed = outcomes.iter().filter(|outcome| outcome.passed).count();
    println!("PARITY {passed}/{} cases match", outcomes.len());
    let report = json!({
        "cases": outcomes.len(),
        "passed": passed,
        "failed": outcomes.len() - passed,
        "outcomes": outcomes,
    });
    let text = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(&args.report, text).map_err(|error| format!("report: {error}"))?;
    Ok(passed == outcomes.len())
}

/// What one server did during a case.
struct Side<'a> {
    label: &'static str,
    copy: &'a Copy,
    server: &'a Server,
    outputs: HashMap<String, Value>,
    canon: Canon,
}

async fn run_case(
    case: &Case,
    env: &GateEnv,
    copies: &Copies,
    servers: [&Server; 2],
    http: &reqwest::Client,
) -> Outcome {
    let vars = Vars { start: Utc::now() };
    let mut problems = Vec::new();
    let mut sides = [
        Side {
            label: "TypeScript",
            copy: &copies.ts,
            server: servers[0],
            outputs: HashMap::new(),
            canon: Canon::new(vars.start, &case.known_ids),
        },
        Side {
            label: "Rust",
            copy: &copies.rs,
            server: servers[1],
            outputs: HashMap::new(),
            canon: Canon::new(vars.start, &case.known_ids),
        },
    ];

    let seed: Result<Vec<String>, String> =
        case.seed.iter().map(|sql| vars.fill_string(sql, &HashMap::new())).collect();
    match seed {
        Ok(seed) => {
            for side in &sides {
                if let Err(error) = side.copy.reset(&seed).await {
                    problems.push(format!("{} {error}", side.label));
                }
            }
        }
        Err(error) => problems.push(error),
    }

    if problems.is_empty() {
        for (index, step) in case.steps.iter().enumerate() {
            let key = step.id.clone().unwrap_or_else(|| index.to_string());
            let mut seen = Vec::new();
            for side in sides.iter_mut() {
                let observed = match perform(step, side, &vars, env, http).await {
                    Ok(value) => value,
                    Err(error) => json!({ "harness error": error }),
                };
                if let Some(expect) = &step.expect {
                    match vars.fill_json(expect, &side.outputs) {
                        Ok(expect) if !contains(&observed, &expect) => problems.push(format!(
                            "step {key}: {} did not match the expectation; got {}",
                            side.label,
                            clip(&observed)
                        )),
                        Ok(_) => {}
                        Err(error) => problems.push(format!("step {key}: {error}")),
                    }
                }
                seen.push(side.canon.value(&observed));
                side.outputs.insert(key.clone(), observed);
            }
            for line in diff(&seen[0], &seen[1], 8) {
                problems.push(format!("step {key}: {line}"));
            }
        }
        for table in &case.rows {
            let mut seen = Vec::new();
            for side in sides.iter_mut() {
                match side.copy.rows(table).await {
                    Ok(rows) => seen.push(Value::Array(side.canon.rows(&rows))),
                    Err(error) => {
                        problems.push(format!("{} {error}", side.label));
                        seen.push(Value::Null);
                    }
                }
            }
            for line in diff(&seen[0], &seen[1], 8) {
                problems.push(format!("rows {table}: {line}"));
            }
        }
    }

    Outcome {
        name: case.name.clone(),
        source: case.source.clone(),
        passed: problems.is_empty(),
        problems,
        note: case.note.clone(),
    }
}

fn clip(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 300 {
        format!("{}...", text.chars().take(297).collect::<String>())
    } else {
        text
    }
}

async fn perform(
    step: &Step,
    side: &Side<'_>,
    vars: &Vars,
    env: &GateEnv,
    http: &reqwest::Client,
) -> Result<Value, String> {
    if let Some(job) = &step.wait_job {
        let id = vars.fill_string(job, &side.outputs)?;
        return side.copy.job(&id).await;
    }
    if let Some(sql) = &step.sql {
        let sql = vars.fill_string(sql, &side.outputs)?;
        let role = match step.role.as_deref() {
            Some("worker") => &env.worker,
            Some("app") | None => &env.app,
            Some(other) => return Err(format!("unknown role {other}")),
        };
        let actor = step.actor.as_deref().and_then(actor_user);
        return Ok(dbs::probe(role, &side.copy.name, actor, &sql).await);
    }

    let method = step.method.as_deref().ok_or("a step needs method, wait_job or sql")?;
    let path = vars.fill_string(step.path.as_deref().ok_or("an HTTP step needs a path")?, &side.outputs)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let mut request = http.request(method, format!("{}{path}", side.server.base));
    if let Some(actor) = step.actor.as_deref() {
        if let Some(token) = actor_token(actor) {
            request = request.header("authorization", format!("Bearer {token}"));
        } else if actor != "anon" {
            return Err(format!("unknown actor {actor}"));
        }
    }
    let mut has_content_type = false;
    for (name, value) in &step.headers {
        let value = match value {
            Value::String(text) => vars.fill_string(text, &side.outputs)?,
            other => other.to_string(),
        };
        has_content_type |= name.eq_ignore_ascii_case("content-type");
        request = request.header(name.as_str(), value);
    }
    if let Some(body) = &step.body {
        let body = vars.fill_json(body, &side.outputs)?;
        if !has_content_type {
            request = request.header("content-type", "application/json");
        }
        request = request.body(body.to_string());
    } else if let Some(raw) = &step.raw {
        request = request.body(vars.fill_string(raw, &side.outputs)?);
    }

    let response = request.send().await.map_err(|error| format!("request failed: {error}"))?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| format!("read body: {error}"))?;
    let body = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(json!({ "text": text }))
    };
    Ok(json!({ "status": status, "body": body }))
}
