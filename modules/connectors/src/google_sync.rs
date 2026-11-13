//! Google sync, package side. A job asks the host for one chunk of Calendar or Gmail at a
//! time, writes the rows through Calendar's and Email's public APIs, and hands the rest to a
//! new job. Job parameters hold only ids, counts, flags and fixed choices. Page tokens, the
//! Gmail position and all mail text stay in the host, and message text is never kept here.
use crate::{kv, refresh, Error, Result};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

pub const QUEUE: &str = "google-sync";
pub const SWEEP: &str = "google-sync-sweep";
/// A refresh the person asked for runs the same sync on its own queue, so the outcome can be
/// recorded against the refresh.
pub const REFRESH_QUEUE: &str = "email-refresh-google";
const CRON: &str = "*/15 * * * *";
const SWEEP_CRON: &str = "*/30 * * * *";
/// Events per Calendar chunk and messages per Gmail chunk.
const CALENDAR_CHUNK: u64 = 100;
const MAIL_CHUNK: u64 = 10;
/// Chunks one job run handles before it hands the rest to a new job. A run has a five second
/// budget, so a run stays small enough to finish inside it on a slow machine.
const CHUNKS_PER_RUN: usize = 1;
/// A message that failed analysis this many times for the same revision is left alone.
const GIVE_UP_AFTER: u64 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Calendar,
    EmailDay,
    Email,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Calendar => "calendar",
            Phase::EmailDay => "email-day",
            Phase::Email => "email",
        }
    }
    fn parse(name: &str) -> Option<Self> {
        [Phase::Calendar, Phase::EmailDay, Phase::Email].into_iter().find(|p| p.name() == name)
    }
}

const ERRORS: [&str; 5] = ["none", "auth-error", "calendar-error", "email-error", "email-message-error"];

/// Everything a sync run carries between chunks.
struct Job {
    account: String,
    phase: Phase,
    cursor: u64,
    calendar_upserted: u64,
    calendar_reconciled: u64,
    email_upserted: u64,
    email_failures: u64,
    trigger: String,
    recent_only: bool,
    error: &'static str,
    email_on: bool,
    calendar_on: bool,
    /// True once the host has marked the run started, so a retried chunk never starts it again.
    begun: bool,
    /// True once a first attempt to record the result failed, so a later job tries once more.
    finishing: bool,
    /// The refresh this run reports to. Refresh runs sync recent mail only and never move the
    /// saved Gmail position.
    refresh: Option<String>,
}

enum Step {
    More,
    Finished,
    Stopped(&'static str),
}

impl Job {
    fn new(account: &str, trigger: &str, recent_only: bool) -> Self {
        Self {
            account: account.into(),
            phase: Phase::Calendar,
            cursor: 0,
            calendar_upserted: 0,
            calendar_reconciled: 0,
            email_upserted: 0,
            email_failures: 0,
            trigger: trigger.into(),
            recent_only,
            error: "none",
            email_on: true,
            calendar_on: true,
            begun: false,
            finishing: false,
            refresh: None,
        }
    }

    /// A manual, mail-only run for a refresh. Calendar is off and the sync starts at the
    /// current-day mail phase.
    fn for_refresh(account: &str, refresh: &str) -> Self {
        let mut run = Self::new(account, "manual", true);
        run.phase = Phase::EmailDay;
        run.calendar_on = false;
        run.refresh = Some(refresh.into());
        run
    }

    fn queue(&self) -> &'static str {
        if self.refresh.is_some() {
            REFRESH_QUEUE
        } else {
            QUEUE
        }
    }

    fn params(&self) -> Value {
        let mut params = self.base_params();
        if let Some(refresh) = &self.refresh {
            params["refresh-id"] = json!(refresh);
        }
        params
    }

    fn base_params(&self) -> Value {
        json!({
            "account-id":self.account,"phase":self.phase.name(),"cursor":self.cursor,
            "calendar-upserted":self.calendar_upserted,"calendar-reconciled":self.calendar_reconciled,
            "email-upserted":self.email_upserted,"email-failures":self.email_failures,
            "trigger":self.trigger,"recent-only":self.recent_only,"error":self.error,
            "email-on":self.email_on,"calendar-on":self.calendar_on,"begun":self.begun,"finishing":self.finishing,
        })
    }

    fn from_params(p: &Value) -> Option<Self> {
        let count = |name: &str| p[name].as_u64();
        Some(Self {
            account: p["account-id"].as_str()?.into(),
            phase: Phase::parse(p["phase"].as_str()?)?,
            cursor: count("cursor")?,
            calendar_upserted: count("calendar-upserted")?,
            calendar_reconciled: count("calendar-reconciled")?,
            email_upserted: count("email-upserted")?,
            email_failures: count("email-failures")?,
            trigger: p["trigger"].as_str()?.into(),
            recent_only: p["recent-only"].as_bool()?,
            error: ERRORS.into_iter().find(|e| Some(*e) == p["error"].as_str())?,
            email_on: p["email-on"].as_bool()?,
            calendar_on: p["calendar-on"].as_bool()?,
            begun: p["begun"].as_bool().unwrap_or(false),
            finishing: p["finishing"].as_bool().unwrap_or(false),
            refresh: p["refresh-id"].as_str().map(String::from),
        })
    }

    fn note(&mut self, error: &'static str) {
        if self.error == "none" {
            self.error = error;
        }
    }

    fn next_phase(&mut self) -> Step {
        self.cursor = 0;
        self.phase = match self.phase {
            Phase::Calendar => Phase::EmailDay,
            Phase::EmailDay if self.recent_only => return Step::Finished,
            Phase::EmailDay => Phase::Email,
            Phase::Email => return Step::Finished,
        };
        Step::More
    }
}

/// Keeps one fifteen-minute sync schedule and one half-hour sweep per Google account. The
/// account id is the key, so a repeat call replaces the row. Scheduling never fails the caller.
pub fn reconcile_schedule(host: &impl Host, account: &str) {
    let _ = schedule(host, QUEUE, CRON, &Job::new(account, "schedule", false).params(), account);
    let _ = schedule(host, SWEEP, SWEEP_CRON, &json!({"account-id":account}), account);
}

fn schedule(host: &impl Host, queue: &str, cron: &str, params: &Value, key: &str) -> Result<Value> {
    Ok(host.call("jobs", "schedule", queue, json!({"cron":cron,"timezone":"UTC","key":key,"params":params}))?)
}

/// Stops both schedules of the account. The keyed schedule call is idempotent and returns the
/// stable row id to cancel.
pub fn cancel_schedule(host: &impl Host, account: &str) {
    for (queue, cron, params) in [
        (QUEUE, CRON, Job::new(account, "schedule", false).params()),
        (SWEEP, SWEEP_CRON, json!({"account-id":account})),
    ] {
        let Ok(saved) = schedule(host, queue, cron, &params, account) else { continue };
        if let Some(id) = saved["id"].as_str() {
            let _ = host.call("jobs", "unschedule", queue, json!({"id":id}));
        }
    }
}

fn enqueue(host: &impl Host, queue: &str, params: Value) -> Result<Value> {
    let context = host.call("context", "read", "call", json!({}))?;
    let key = host.call("context", "uuid", "new", json!({}))?;
    Ok(host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":params,"idempotencyKey":key["id"],"availableAt":context["now"]}),
    )?)
}

/// The first job parameters of a refresh run for one Google account.
pub fn refresh_first(account: &str, refresh: &str) -> Value {
    Job::for_refresh(account, refresh).params()
}

/// Starts a sync now. Used after connecting and by the manual route.
pub fn sync_soon(host: &impl Host, account: &str, trigger: &str, recent_only: bool) -> Result<Value> {
    enqueue(host, QUEUE, Job::new(account, trigger, recent_only).params())
}

/// The manual sync route. It queues one run for the person's connected Google account.
pub fn sync_route(host: &impl Host, body: &Value) -> Result<(u16, Value)> {
    let accounts = kv(host, "get", "connectors.accounts", json!({}))?;
    let account = accounts
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["providerId"] == "google" && a["status"] == "active")
        .and_then(|a| a["id"].as_str());
    let Some(account) = account else {
        return Err(Error::new(409, "Google is not connected"));
    };
    let recent_only = body["recentOnly"].as_bool().unwrap_or(false);
    let queued = sync_soon(host, account, "manual", recent_only)?;
    Ok((202, json!({"enqueued":true,"deduped":false,"jobId":queued["id"]})))
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid Google sync job")?;
    let p = &job["parameters"];
    let outcome = match job["queue"].as_str() {
        Some(QUEUE) => {
            let mut run = Job::from_params(p).ok_or("Invalid Google sync job")?;
            run_job(host, &mut run)
        }
        Some(REFRESH_QUEUE) => {
            let mut run = Job::from_params(p).ok_or("Invalid Google sync job")?;
            let Some(refresh) = run.refresh.clone() else { return Err("Invalid Google sync job".into()) };
            if !run.begun && !refresh::begin(host, &refresh, &run.account, "google").map_err(|e| e.message)? {
                return Ok(json!({"outcome":"skipped"}).to_string());
            }
            match run_job(host, &mut run) {
                // The account is mid-sync or the host failed, so a queue retry tries again. A stuck
                // row is failed by the refresh sweep.
                "busy" | "failed" => return Err("Google sync is not ready".into()),
                "inactive" => {
                    refresh::finish(host, &refresh, &run.account, "failed", Some("no-active-connection"), 0, 0);
                    "inactive"
                }
                outcome => outcome,
            }
        }
        Some(SWEEP) => sweep(host, p["account-id"].as_str().ok_or("Invalid Google sync job")?),
        _ => return Err("Connectors job is unavailable".into()),
    };
    Ok(json!({"outcome":outcome}).to_string())
}

/// Restarts a sync for an account whose last run did not succeed. A healthy account keeps its
/// own fifteen-minute schedule, and a revoked one loses both schedules.
fn sweep(host: &impl Host, account: &str) -> &'static str {
    let Ok(found) = kv(host, "get", "connectors.accounts", json!({"id":account})) else { return "failed" };
    let row = found.as_array().and_then(|rows| rows.first());
    match row {
        Some(row) if row["status"] == "active" => {
            let healthy = matches!(row["lastSyncStatus"].as_str(), Some("success" | "partial"));
            if healthy {
                return "healthy";
            }
            // A refused sign-in can only fail again until the person signs in once more.
            if row["lastSyncError"] == "auth-error" {
                return "needs-sign-in";
            }
            match sync_soon(host, account, "schedule", false) {
                Ok(_) => "restarted",
                Err(_) => "failed",
            }
        }
        _ => {
            cancel_schedule(host, account);
            "inactive"
        }
    }
}

fn finish(host: &impl Host, run: &mut Job) -> &'static str {
    let status = match run.error {
        "none" => "success",
        "auth-error" | "email-error" => "failed",
        _ => "partial",
    };
    let error = (run.error != "none").then_some(run.error);
    let save = status == "success" && run.email_on && !run.recent_only;
    let saved = kv(
        host,
        "set",
        "connectors.sync-google-finish",
        json!({
            "accountId":run.account,"status":status,"error":error,"savePosition":save,
            "counts":{
                "calendarUpserted":run.calendar_upserted,"calendarReconciled":run.calendar_reconciled,
                "emailUpserted":run.email_upserted,"emailFailures":run.email_failures,"truncated":false,
            },
        }),
    );
    if saved.is_err() && !run.finishing {
        // The result is not lost. One later job records it, so the account does not stay in progress.
        run.finishing = true;
        let _ = enqueue(host, run.queue(), run.params());
        return "finish-retried";
    }
    if let Some(id) = &run.refresh {
        let (status, error) = refresh::outcome(run.error);
        refresh::finish(host, id, &run.account, status, error, run.email_upserted, run.email_failures);
    }
    if run.error == "auth-error" {
        cancel_schedule(host, &run.account);
    }
    "done"
}

/// One run of the job. A host failure ends the run as failed instead of retrying, so a broken
/// service is not hit again at once.
fn run_job(host: &impl Host, run: &mut Job) -> &'static str {
    if (run.phase == Phase::Calendar || run.refresh.is_some()) && run.cursor == 0 && !run.begun {
        match kv(host, "set", "connectors.sync-google-start", json!({"accountId":run.account,"trigger":run.trigger})) {
            Ok(started) => match started["state"].as_str() {
                Some("started") => {
                    run.email_on = started["email"].as_bool().unwrap_or(false);
                    // A refresh reads mail only.
                    run.calendar_on = run.refresh.is_none() && started["calendar"].as_bool().unwrap_or(false);
                    reconcile_schedule(host, &run.account);
                    run.begun = true;
                    // The first chunk runs in its own job, so a retry of it finds the run already started.
                    return match enqueue(host, run.queue(), run.params()) {
                        Ok(_) => "continued",
                        Err(_) => {
                            run.note("email-error");
                            finish(host, run)
                        }
                    };
                }
                Some("busy") => return "busy",
                _ => {
                    cancel_schedule(host, &run.account);
                    return "inactive";
                }
            },
            Err(_) => return "failed",
        }
    }
    if run.finishing {
        return finish(host, run);
    }
    for _ in 0..CHUNKS_PER_RUN {
        match chunk(host, run) {
            Ok(Step::More) => {}
            Ok(Step::Finished) => return finish(host, run),
            Ok(Step::Stopped(word)) => return word,
            Err(_) => {
                if run.error != "auth-error" {
                    run.error = if run.phase == Phase::Calendar { "calendar-error" } else { "email-error" };
                }
                return finish(host, run);
            }
        }
    }
    match enqueue(host, run.queue(), run.params()) {
        Ok(_) => "continued",
        Err(_) => {
            run.note("email-error");
            finish(host, run)
        }
    }
}

fn chunk(host: &impl Host, run: &mut Job) -> Result<Step> {
    match run.phase {
        Phase::Calendar if run.calendar_on => calendar_chunk(host, run),
        Phase::EmailDay | Phase::Email if run.email_on => mail_chunk(host, run),
        _ => Ok(run.next_phase()),
    }
}

fn calendar_chunk(host: &impl Host, run: &mut Job) -> Result<Step> {
    let page = kv(
        host,
        "get",
        "connectors.sync-google-calendar",
        json!({"accountId":run.account,"cursor":run.cursor,"limit":CALENDAR_CHUNK}),
    )?;
    match page["result"].as_str() {
        None => {}
        Some("inactive") => {
            cancel_schedule(host, &run.account);
            return Ok(Step::Stopped("inactive"));
        }
        Some("auth_failed") => {
            run.note("auth-error");
            return Ok(Step::Finished);
        }
        Some(_) => {
            run.note("calendar-error");
            return Ok(run.next_phase());
        }
    }
    for item in page["events"].as_array().into_iter().flatten() {
        let mut input = item["event"].clone();
        input["connectorAccountId"] = json!(run.account);
        input["externalId"] = item["externalId"].clone();
        match Client(host).api("calendar", "upsertCachedEvent", input) {
            Ok(_) => run.calendar_upserted += 1,
            Err(_) => run.note("calendar-error"),
        }
    }
    if page["done"] != true {
        run.cursor = page["next"].as_u64().unwrap_or(run.cursor + CALENDAR_CHUNK);
        return Ok(Step::More);
    }
    // Only a walk that read and wrote everything shows that an uncached event is gone.
    if run.error != "calendar-error" && run.error != "auth-error" {
        match Client(host).api(
            "calendar",
            "pruneCachedEvents",
            json!({"connectorAccountId":run.account,"seenSince":page["seenSince"]}),
        ) {
            Ok(pruned) => run.calendar_reconciled += pruned["deleted"].as_u64().unwrap_or(0),
            Err(_) => run.note("calendar-error"),
        }
    }
    Ok(run.next_phase())
}

/// True when the cached copy is the same revision and needs no rewrite or retry.
fn settled(cached: Option<&Value>, message: &Value) -> bool {
    let Some(known) = cached else { return false };
    let same = !message["historyId"].is_null() && known["historyId"] == message["historyId"];
    same && (known["finished"] == true || known["analysisAttempts"].as_u64().unwrap_or(0) >= GIVE_UP_AFTER)
}

fn mail_chunk(host: &impl Host, run: &mut Job) -> Result<Step> {
    let listed = kv(
        host,
        "get",
        "connectors.sync-google-list",
        json!({"accountId":run.account,"phase":run.phase.name(),"cursor":run.cursor,"limit":MAIL_CHUNK}),
    )?;
    match listed["result"].as_str() {
        None => {}
        Some("inactive") => {
            cancel_schedule(host, &run.account);
            return Ok(Step::Stopped("inactive"));
        }
        Some("auth_failed") => {
            run.note("auth-error");
            return Ok(Step::Finished);
        }
        Some(_) => {
            run.note("email-error");
            return Ok(Step::Finished);
        }
    }
    let ids = listed["ids"].as_array().cloned().unwrap_or_default();
    let before = run.cursor;
    let processed = if ids.is_empty() { 0 } else { write_messages(host, run, &ids)? };
    if run.error == "auth-error" {
        return Ok(Step::Finished);
    }
    if processed < ids.len() {
        // Google was slow, so the rest of this slice is read again by the next job.
        run.cursor = before + processed as u64;
        return Ok(Step::More);
    }
    if listed["done"] == true {
        return Ok(run.next_phase());
    }
    run.cursor = listed["next"].as_u64().unwrap_or(run.cursor + MAIL_CHUNK);
    Ok(Step::More)
}

/// Saves the fetched messages and says how many of `ids` the host got through.
fn write_messages(host: &impl Host, run: &mut Job, ids: &[Value]) -> Result<usize> {
    let fetched = kv(
        host,
        "get",
        "connectors.sync-google-fetch",
        json!({"accountId":run.account,"phase":run.phase.name(),"ids":ids}),
    )?;
    match fetched["result"].as_str() {
        None => {}
        Some("auth_failed") => {
            run.note("auth-error");
            return Ok(ids.len());
        }
        Some(_) => {
            run.note("email-error");
            run.email_failures += ids.len() as u64;
            return Ok(ids.len());
        }
    }
    let processed = fetched["processed"].as_u64().map_or(ids.len(), |n| (n as usize).clamp(1, ids.len()));
    let failures = fetched["failures"].as_u64().unwrap_or(0);
    if failures > 0 {
        run.email_failures += failures;
        run.note("email-message-error");
    }
    let messages = fetched["messages"].as_array().cloned().unwrap_or_default();
    let external: Vec<&Value> = messages.iter().map(|m| &m["externalId"]).collect();
    let cached = Client(host).api(
        "email",
        "listCachedMessageKeys",
        json!({"connectorAccountId":run.account,"externalIds":external}),
    )?;
    let find = |id: &Value| cached["keys"].as_array().into_iter().flatten().find(|k| &k["externalId"] == id);
    for message in &messages {
        if settled(find(&message["externalId"]), message) {
            continue;
        }
        let stored = Client(host).api(
            "email",
            "insertCachedMessage",
            json!({
                "connectorAccountId":run.account,"externalId":message["externalId"],
                "sender":message["sender"],"recipients":message["recipients"],
                "subject":message["subject"],"snippet":message["snippet"],
                "receivedAt":message["receivedAt"],
                "externalMetadata":{
                    "labelIds":message["labelIds"],"historyId":message["historyId"],
                    "threadId":message["threadId"],"messageId":message["messageId"],
                    "references":message["references"],
                },
            }),
        );
        match stored {
            Ok(_) => run.email_upserted += 1,
            Err(_) => {
                run.email_failures += 1;
                run.note("email-message-error");
            }
        }
    }
    Ok(processed)
}
