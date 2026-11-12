//! Runs the fake Google as its own process, for a live run of the real server.
//! Usage: fake-google <code>... Each code is accepted once as an authorization code.
use moss_standins::google::{GoogleConfig, GoogleStandIn};

#[tokio::main]
async fn main() {
    let mut codes: Vec<String> = std::env::args().skip(1).collect();
    if codes.is_empty() {
        codes.push("live-proof-code".into());
    }
    let google = GoogleStandIn::start(GoogleConfig::default()).await;
    println!("token-url {}", google.token_url());
    println!("client-id fake-client-id.apps.example.com");
    println!("client-secret fake-client-secret");
    for code in codes {
        google.issue_code(&code);
        println!("code {code}");
    }
    // Commands on stdin change the mailbox and calendar while the server runs. Messages are
    // named by subject. Message bodies pad past the 100-character preview, then end in a marker.
    //   message <subject>        event <title> <days from now>
    //   delete-message <subject> label-message <subject>   remove-event <title>
    let google = std::sync::Arc::new(google);
    let shared = google.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut ids: std::collections::HashMap<String, String> = Default::default();
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let (word, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
            match word {
                "message" => {
                    let pad = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna";
                    let raw = format!("From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: {rest}\r\nMessage-ID: <{}@example.com>\r\nContent-Type: text/plain\r\n\r\n{pad} GOOGLE-BODY-MARKER-{}", rest.replace(' ', "-"), rest.replace(' ', "-"));
                    ids.insert(rest.into(), shared.add_message(&raw, &["INBOX"]));
                }
                "delete-message" => {
                    if let Some(id) = ids.get(rest) {
                        shared.delete_message(id);
                    }
                }
                "label-message" => {
                    if let Some(id) = ids.get(rest) {
                        shared.add_label(id, "STARRED");
                    }
                }
                "event" => {
                    let (title, days) = rest.rsplit_once(' ').unwrap_or((rest, "1"));
                    let days: i64 = days.parse().unwrap_or(1);
                    let day = |n: i64, hour: u32| {
                        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + n * 86_400;
                        let (y, m, d) = civil(secs.div_euclid(86_400));
                        format!("{y:04}-{m:02}-{d:02}T{hour:02}:00:00Z")
                    };
                    shared.add_event(title, &day(days, 10), &day(days, 11));
                }
                "remove-event" => shared.remove_event_titled(rest),
                _ => {}
            }
        }
    });
    std::future::pending::<()>().await;
}

/// Calendar date for a count of days since 1970-01-01 (proleptic Gregorian).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
