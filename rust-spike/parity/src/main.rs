//! Differential checks for Tasks (Phase 0b, plan section 2.3) and the platform safety core.
//!
//! Sends the same requests to the TypeScript server and the Rust server, each on its own clone of
//! the gate database, and compares status, body, job results and the rows each case left behind.
//! After the last case it reads both server logs, which must never hold a `MOSS-SENTINEL-` value.
//! Runs only inside a gate run.

mod canon;
mod case;
mod dbs;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
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

/// Cases put this in every password and secret they send. No server log may hold it.
const SENTINEL: &str = "MOSS-SENTINEL-";

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
        .env("JARVIS_EMBED_PROVIDER", "stub")
        // The sign-in cases make more auth requests than the default limit of 10 allows.
        .env("JARVIS_RL_AUTH_MAX", "1000");
    let ts = Server::start(
        "TypeScript",
        ts_command,
        args.ts_port,
        &env.env_for(&copies.ts.name),
        args.logs.join("ts-server.log"),
    )
    .await?;
    // Both servers run in test mode, where better-auth turns its origin checks off.
    let mut rs_command = Command::new(&args.rs_bin);
    rs_command.env("NODE_ENV", "test");
    let rs = match Server::start(
        "Rust",
        rs_command,
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
    let logs = scan_logs(&args.logs);
    println!("{} {}", if logs.passed { "PASS" } else { "FAIL" }, logs.name);
    for problem in &logs.problems {
        println!("     {problem}");
    }
    outcomes.push(logs);

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
    /// Cookies saved by `save_cookie`, as `name=value` pairs ready for a Cookie header.
    cookies: HashMap<String, String>,
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
            cookies: HashMap::new(),
            canon: Canon::new(vars.start, &case.known_ids),
        },
        Side {
            label: "Rust",
            copy: &copies.rs,
            server: servers[1],
            outputs: HashMap::new(),
            cookies: HashMap::new(),
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
                let result = perform(step, side, &vars, env, http).await;
                let observed = observe(result, &key, side.label, &mut problems);
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
                let text = observed.to_string().to_lowercase();
                for needle in &step.absent {
                    if text.contains(&needle.to_lowercase()) {
                        problems.push(format!("step {key}: {} output holds {needle:?}", side.label));
                    }
                }
                let compared = match &step.compare {
                    Some(pointers) => select(&observed, pointers),
                    None => observed.clone(),
                };
                seen.push(side.canon.value(&compared));
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

/// The value a step produced. A step the runner could not carry out is a problem on that side,
/// so the same runner error on both sides never counts as a match.
fn observe(
    result: Result<Value, String>,
    key: &str,
    label: &str,
    problems: &mut Vec<String>,
) -> Value {
    result.unwrap_or_else(|error| {
        problems.push(format!("step {key}: {label} could not run the step: {error}"));
        json!({ "harness error": error })
    })
}

/// The parts of `value` the pointers name, keyed by pointer. A missing part is null.
fn select(value: &Value, pointers: &[String]) -> Value {
    let mut out = Map::new();
    for pointer in pointers {
        out.insert(pointer.clone(), value.pointer(pointer).cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

/// Reads Set-Cookie headers. Returns what each cookie's attributes say, keyed by cookie name,
/// with the value reduced to "set" or "empty", and the `name=value` pairs to send back.
fn read_cookies(headers: &[String]) -> (Map<String, Value>, Vec<String>) {
    let mut seen = Map::new();
    let mut jar = Vec::new();
    for header in headers {
        let mut parts = header.split(';').map(str::trim);
        let Some((name, value)) = parts.next().and_then(|pair| pair.split_once('=')) else {
            continue;
        };
        let mut attributes = Map::new();
        attributes.insert("value".into(), json!(if value.is_empty() { "empty" } else { "set" }));
        for part in parts.filter(|part| !part.is_empty()) {
            match part.split_once('=') {
                Some((key, text)) => attributes.insert(key.trim().to_ascii_lowercase(), json!(text.trim())),
                None => attributes.insert(part.to_ascii_lowercase(), json!(true)),
            };
        }
        if !value.is_empty() {
            jar.push(format!("{name}={value}"));
        }
        seen.insert(name.to_owned(), Value::Object(attributes));
    }
    (seen, jar)
}

/// Counts the lines in each server log that hold [`SENTINEL`].
fn scan_logs(logs: &Path) -> Outcome {
    let mut problems = Vec::new();
    for (label, file) in [("TypeScript", "ts-server.log"), ("Rust", "rs-server.log")] {
        match std::fs::read(logs.join(file)) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let lines = text.lines().filter(|line| line.contains(SENTINEL)).count();
                if lines > 0 {
                    problems.push(format!("{label} server log: {lines} lines hold {SENTINEL}"));
                }
            }
            Err(error) => problems.push(format!("{label} server log: {error}")),
        }
    }
    Outcome {
        name: format!("server logs hold no {SENTINEL} value"),
        source: "safety: every password and secret a case sends carries the sentinel".into(),
        passed: problems.is_empty(),
        problems,
        note: None,
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
    side: &mut Side<'_>,
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
            Some("auth") => &env.auth,
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
    if let Some(name) = &step.cookie {
        let jar = side.cookies.get(name).ok_or_else(|| format!("no cookie saved as {name}"))?;
        request = request.header("cookie", jar.as_str());
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
    let set_cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect();
    let text = response.text().await.map_err(|error| format!("read body: {error}"))?;
    let body = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(json!({ "text": text }))
    };
    let (cookies, jar) = read_cookies(&set_cookies);
    if let Some(name) = &step.save_cookie {
        if jar.is_empty() {
            return Err(format!("the response set no cookie to save as {name} (status {status})"));
        }
        side.cookies.insert(name.clone(), jar.join("; "));
    }
    let mut output = json!({ "status": status, "body": body });
    if !cookies.is_empty() {
        output["cookies"] = Value::Object(cookies);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_errors_are_problems() {
        let mut problems = Vec::new();
        let error = Err("request failed: refused".to_owned());
        let value = observe(error, "make", "Rust", &mut problems);
        assert_eq!(value, json!({ "harness error": "request failed: refused" }));
        assert_eq!(
            problems,
            vec!["step make: Rust could not run the step: request failed: refused"]
        );

        let mut problems = Vec::new();
        let value = observe(Ok(json!({ "status": 200 })), "make", "Rust", &mut problems);
        assert_eq!(value, json!({ "status": 200 }));
        assert!(problems.is_empty());
    }

    #[test]
    fn reads_cookies_without_their_values() {
        let headers = vec![
            "better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax"
                .to_owned(),
            "better-auth.dont_remember=; Max-Age=0; Path=/".to_owned(),
        ];
        let (seen, jar) = read_cookies(&headers);
        assert_eq!(
            Value::Object(seen),
            json!({
                "better-auth.session_token": {
                    "value": "set", "max-age": "604800", "path": "/", "httponly": true,
                    "samesite": "Lax"
                },
                "better-auth.dont_remember": { "value": "empty", "max-age": "0", "path": "/" }
            })
        );
        assert_eq!(jar, vec!["better-auth.session_token=abc.def%3D"]);
    }

    #[test]
    fn selects_parts_by_pointer() {
        let output = json!({ "status": 200, "body": { "token": "x", "user": { "id": 1 } } });
        let pointers = vec!["/status".to_owned(), "/body/user".to_owned(), "/body/gone".to_owned()];
        assert_eq!(
            select(&output, &pointers),
            json!({ "/status": 200, "/body/user": { "id": 1 }, "/body/gone": null })
        );
    }

    #[test]
    fn a_sentinel_in_either_log_fails_the_scan() {
        let dir = std::env::temp_dir().join(format!("parity-scan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ts-server.log"), "TS READY 1\n").unwrap();
        std::fs::write(dir.join("rs-server.log"), "listening\n").unwrap();
        assert!(scan_logs(&dir).passed);
        std::fs::write(dir.join("rs-server.log"), "body {\"password\":\"MOSS-SENTINEL-1\"}\n").unwrap();
        let outcome = scan_logs(&dir);
        assert!(!outcome.passed);
        assert_eq!(outcome.problems, vec!["Rust server log: 1 lines hold MOSS-SENTINEL-"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
