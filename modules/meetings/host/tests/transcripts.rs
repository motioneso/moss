//! Transcript and History proofs against the installed package and a real database.
//! Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
mod support;
use serde_json::{json, Value};
use support::install::install;

const MARK: &str = "PLANTED-MARKER-7e3a51";

fn load_cases() -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/transcript-cases.json")).unwrap();
    serde_json::from_str(&unpack(&text)).unwrap()
}

/// Reverses the `~~REP(char,count)~~` packing the fixture file uses for long runs.
fn unpack(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("~~REP(") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 6..];
        let end = tail.find(")~~").expect("closed run");
        let (ch, n) = tail[..end].rsplit_once(',').unwrap();
        out.push_str(&ch.repeat(n.parse().unwrap()));
        rest = &tail[end + 3..];
    }
    out.push_str(rest);
    out
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}
fn shaped(b: &[u8], pattern: &str) -> bool {
    b.len() >= pattern.len()
        && pattern.bytes().zip(b).all(|(p, c)| match p {
            b'9' => c.is_ascii_digit(),
            b'h' => is_hex(*c),
            p => p == *c,
        })
}

/// Hides what differs between runs: times, and ids that are not part of the fixture.
fn scrub(text: &str) -> String {
    let (b, mut out, mut i) = (text.as_bytes(), String::new(), 0);
    while i < b.len() {
        let rest = &b[i..];
        if shaped(rest, "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh") {
            let id = &text[i..i + 36];
            let fixed = id.starts_with("00000000-0000-4000") || id.starts_with("99999999-9999");
            out.push_str(if fixed { id } else { "<id>" });
            i += 36;
        } else if shaped(rest, "9999-99-99T99:99:99") {
            let mut end = i + 19;
            if b.get(end) == Some(&b'.') {
                end += 1;
                while b.get(end).is_some_and(u8::is_ascii_digit) {
                    end += 1;
                }
            }
            if b.get(end) == Some(&b'Z') {
                out.push_str("<time>");
                i = end + 1;
            } else {
                out.push(b[i] as char);
                i += 1;
            }
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Whole numbers read the same whether they came back as integers or floats.
fn canon(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => json!(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(canon).collect()),
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (k, canon(v))).collect()),
        v => v,
    }
}

fn encode(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

struct World {
    f: support::Fixture,
    app: support::install::Installed,
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        let app = install(&f);
        Self { f, app }
    }
    /// The reply the shell gives, or its failure text when the shell refuses the request itself.
    fn send(&self, actor: uuid::Uuid, method: &str, target: &str, body: &str) -> Result<Value, String> {
        let text = self
            .app
            .app
            .dispatch_extended(self.f.access(actor), method, &format!("/api/m/meetings{target}"), body)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::from_str(&text).unwrap())
    }
    fn call(&self, actor: uuid::Uuid, method: &str, target: &str, body: Value) -> Value {
        self.send(actor, method, target, &body.to_string()).unwrap()
    }
    fn person(&self) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Replay',false)",
            &[&id, &format!("{id}@example.test")],
        )).unwrap();
        id
    }
    fn meeting(&self, actor: uuid::Uuid, n: usize) -> String {
        let made = self.call(actor, "POST", "/records", json!({"requestKey": uuid::Uuid::new_v4(), "title": format!("Oracle meeting {n}")}));
        assert_eq!(made["status"], 201, "{made}");
        made["body"]["meeting"]["id"].as_str().unwrap().to_owned()
    }
    fn rows(&self, id: &str) -> Value {
        let one = |sql: &str| -> Value {
            self.f.rt.block_on(async {
                self.f.root.query_one(sql, &[&id]).await.unwrap().get::<_, Value>(0)
            })
        };
        json!({
            "batches": one("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]') FROM (SELECT request_key::text, version, input_json, transcript_revision, cursor, stop_cutoff_ms, history_sources_json, history_omitted_sources FROM app.meeting_transcript_batches WHERE meeting_id=$1::text::uuid) t"),
            "segments": one("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY segment_key),'[]') FROM (SELECT segment_key, revision, start_ms, end_ms, finality, search_terms FROM app.meeting_history_segments WHERE meeting_id=$1::text::uuid) t"),
        })
    }
    /// Writes rows the old code left behind, as that code wrote them.
    fn plant(&self, id: &str, rows: &Value, owner: uuid::Uuid, old_id: &str) {
        self.f.rt.block_on(async {
            for b in rows["batches"].as_array().unwrap() {
                let input = b["input_json"].as_str().unwrap().replace(old_id, id);
                self.f.root.execute(
                    "INSERT INTO app.meeting_transcript_batches(meeting_id,owner_user_id,request_key,version,input_json,transcript_revision,cursor,stop_cutoff_ms,history_sources_json,history_omitted_sources) VALUES($1::text::uuid,$2,$3::text::uuid,$4,$5,$6,$7,$8,$9,$10)",
                    &[&id, &owner, &b["request_key"].as_str().unwrap(), &(b["version"].as_i64().unwrap() as i32), &input,
                      &(b["transcript_revision"].as_i64().unwrap() as i32), &b["cursor"].as_f64().unwrap(), &b["stop_cutoff_ms"].as_f64(),
                      &b["history_sources_json"].as_str().unwrap(), &(b["history_omitted_sources"].as_i64().unwrap() as i32)],
                ).await.unwrap();
            }
            for s in rows["segments"].as_array().unwrap() {
                let terms: Vec<String> = s["search_terms"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
                self.f.root.execute(
                    "INSERT INTO app.meeting_history_segments(meeting_id,owner_user_id,segment_key,revision,start_ms,end_ms,finality,search_terms) VALUES($1::text::uuid,$2,$3,$4,$5,$6,$7,$8)",
                    &[&id, &owner, &s["segment_key"].as_str().unwrap(), &s["revision"].as_f64().unwrap(), &s["start_ms"].as_f64().unwrap(),
                      &s["end_ms"].as_f64().unwrap(), &s["finality"].as_str().unwrap(), &terms],
                ).await.unwrap();
            }
        });
    }
}

/// Replays one recorded step. Returns a note when the shell, not the package, decides the reply.
fn replay(w: &World, who: (uuid::Uuid, uuid::Uuid), step: &Value, names: &[(String, String)], only_reread: bool) -> Option<String> {
    if only_reread && step["reread"] != true {
        return None;
    }
    let fill = |text: &str| names.iter().fold(text.to_owned(), |t, (n, id)| t.replace(&format!("{{{n}}}"), id));
    let back = |text: &str| names.iter().fold(text.to_owned(), |t, (n, id)| t.replace(id.as_str(), &format!("{{{n}}}")));
    let actor = if step["as"] == "b" { who.1 } else { who.0 };
    let path = fill(step["path"].as_str().unwrap()).replacen("/api/meetings", "", 1);
    let query: Vec<String> = step["query"].as_object().map(|q| {
        q.iter().map(|(k, v)| format!("{}={}", encode(k), encode(&fill(v.as_str().unwrap())))).collect()
    }).unwrap_or_default();
    let target = if query.is_empty() { path } else { format!("{path}?{}", query.join("&")) };
    let body = match step.get("raw") {
        Some(raw) => raw.as_str().unwrap().to_owned(),
        None => fill(&step.get("body").map_or("null".into(), Value::to_string)),
    };
    let label = format!("{} {target}", step["method"].as_str().unwrap());
    let shell = step["shell"] == true;
    let got = match w.send(actor, step["method"].as_str().unwrap(), &target, &body) {
        Ok(got) => got,
        Err(e) if shell => return Some(format!("{label}: the shell refused it ({e}); the old route answered {}", step["status"])),
        Err(e) => {
            let why: Vec<String> = e.lines().rev().take(4).map(str::to_owned).collect();
            panic!("{label} (body {} bytes, old status {}): the shell refused a request the old route handled: {}", body.len(), step["status"], why.join(" | "))
        }
    };
    let expected = canon(serde_json::from_str(&scrub(&step["reply"].to_string())).unwrap());
    let actual = canon(serde_json::from_str(&scrub(&back(&got["body"].to_string()))).unwrap());
    if shell && (got["status"] != step["status"] || actual != expected) {
        return Some(format!("{label}: status {} body {actual} (old route: {} {expected})", got["status"], step["status"]));
    }
    assert_eq!(got["status"], step["status"], "{label}: status");
    assert_eq!(actual, expected, "{label}: body");
    None
}

#[test]
#[ignore = "Only through verify-gate"]
fn every_old_transcript_and_history_case_gives_the_same_reply_and_rows() {
    let w = World::new();
    let cases = load_cases();
    assert!(cases.iter().map(|c| c["steps"].as_array().unwrap().len()).sum::<usize>() >= 160);
    let mut notes = vec![];
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let who = (w.person(), w.person());
        let mut names = vec![("M".to_owned(), w.meeting(who.0, 1))];
        for i in 0..case["extra"].as_u64().unwrap() {
            names.push((format!("M{}", i + 2), w.meeting(who.0, i as usize + 2)));
        }
        for step in case["steps"].as_array().unwrap() {
            notes.extend(replay(&w, who, step, &names, false).map(|n| format!("{name}: {n}")));
        }
        // Rows written by the new package match the rows the old code wrote.
        let back = |t: &str| names.iter().fold(t.to_owned(), |t, (n, id)| t.replace(id.as_str(), &format!("{{{n}}}")));
        let actual: Value = serde_json::from_str(&scrub(&back(&w.rows(&names[0].1).to_string()))).unwrap();
        let expected: Value = serde_json::from_str(&scrub(&case["rows"].to_string())).unwrap();
        assert_eq!(canon(actual), canon(expected), "{name}: stored rows");
        // Rows written by the old code read back the same through the new package.
        if !case["rows"]["batches"].as_array().unwrap().is_empty() {
            let again = (w.person(), w.person());
            let fresh = vec![("M".to_owned(), w.meeting(again.0, 1))];
            w.plant(&fresh[0].1, &case["rows"], again.0, "{M}");
            for step in case["steps"].as_array().unwrap() {
                replay(&w, again, step, &fresh, true);
            }
            println!("REREAD {name}: rows written by the old code read the same");
        }
    }
    for n in &notes {
        println!("SHELL {n}");
    }
}

fn batch(version: u32, key: u32, text: &str, id: &str) -> Value {
    json!({"requestKey": format!("00000000-0000-4000-8000-{key:012}"), "expectedVersion": version,
        "sources": [{"sourceId":"mic","epoch":1,"kind":"microphone","label":"Microphone","startMs":0,"endMs":1000}],
        "events": [{"cursor":1,"segment":{"meetingId":id,"segmentId":"s1","sourceId":"mic","epoch":1,"startMs":10,"endMs":19,
            "revision":1,"text":text,"finality":"final","provenance":"transcription","speakerId":null}}],
        "stopCutoffMs": null})
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_and_an_administrator_see_no_transcript_or_history() {
    let w = World::new();
    let (f, id) = (&w.f, w.meeting(w.f.a, 1));
    let saved = w.call(f.a, "POST", &format!("/records/{id}/transcript"), batch(0, 1, &format!("budget {MARK} review"), &id));
    assert_eq!(saved["status"], 201, "{saved}");
    let word = MARK.to_lowercase();
    let search = |actor| w.call(actor, "POST", "/history/search", json!({"query": word}));
    let owner = search(f.a);
    assert_eq!(owner["body"]["meetings"].as_array().unwrap().len(), 1, "owner finds it: {owner}");

    // Every new route, as person B and as an administrator.
    let reads = |actor| {
        let read = format!("/records/{id}/transcript?maxSegments=10&maxCharacters=1000");
        let evidence = format!("/records/{id}/transcript/evidence?segmentId=s1&segmentRevision=1&startCharacter=0&endCharacter=5");
        vec![
            w.call(actor, "GET", &read, Value::Null),
            w.call(actor, "GET", &evidence, Value::Null),
            w.call(actor, "POST", &format!("/records/{id}/transcript"), batch(1, 2, "intruder", &id)),
            w.call(actor, "POST", "/history/search", json!({"query": word})),
            w.call(actor, "POST", "/history/search", json!({})),
            w.call(actor, "GET", &format!("/history/{id}"), Value::Null),
        ]
    };
    for actor in [f.b, f.admin] {
        let out = reads(actor);
        let statuses: Vec<_> = out.iter().map(|r| r["status"].clone()).collect();
        assert_eq!(statuses, [404, 404, 404, 200, 200, 404], "{out:?}");
        assert!(out.iter().all(|r| !r.to_string().contains(MARK)), "a reply carried the transcript text");
        assert_eq!(out[3]["body"]["meetings"], json!([]));
        assert_eq!(out[4]["body"]["meetings"], json!([]));
    }
    let after = w.call(f.a, "GET", &format!("/records/{id}/transcript?maxSegments=10&maxCharacters=1000"), Value::Null);
    assert_eq!(after["body"]["snapshot"]["transcriptRevision"], 1, "another person changed the transcript");

    // Without row security the same reads must leak, with it restored they must not.
    let open = |table: &str| -> bool {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
        let leaked = w.call(f.b, "GET", &format!("/records/{id}/transcript?maxSegments=10&maxCharacters=1000"), Value::Null)["status"] == 200
            || f.rt.block_on(async {
                let cx = safety_core::db::DataContext::open(&f.db, &f.access(f.b)).await.unwrap();
                let n: i64 = cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0);
                n > 0
            });
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY"))).unwrap();
        leaked
    };
    for table in ["app.meeting_transcript_batches", "app.meeting_history_segments"] {
        assert!(open(table), "RED expected: {table} shows another person's data with row security removed");
        println!("RED {table}: another person sees the data with row security removed");
        let seen = reads(f.b)[0]["status"].clone();
        assert_eq!(seen, 404, "{table}: not restored");
        println!("GREEN {table}: row security restored");
    }

    // The transcript text stays out of queued work, activity and model logs.
    let (jobs, activity): (i64, i64) = f.rt.block_on(async {
        let count = |t: &str| format!("SELECT CASE WHEN to_regclass('{t}') IS NULL THEN 0 ELSE (SELECT count(*) FROM {t} x WHERE x::text LIKE '%{MARK}%') END");
        let jobs = f.root.query_one(&count("pgboss.job"), &[]).await.unwrap().get(0);
        let act = f.root.query_one(&count("app.moss_activity_detail"), &[]).await.unwrap().get::<_, i64>(0)
            + f.root.query_one(&count("app.moss_model_activity_log"), &[]).await.unwrap().get::<_, i64>(0);
        (jobs, act)
    });
    assert_eq!((jobs, activity), (0, 0), "transcript text reached queued work or activity rows");
}
