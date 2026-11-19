//! Readiness for the three real-server People gates, including a cold guest compile.
use reqwest::blocking::Client;
use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

pub fn wait_for_people(
    client: &Client,
    origin: &str,
    cookie: &str,
    expected: u16,
    server_log: &Path,
) {
    // Reuse the People gate's existing budget. A cold guest GET alone took 35–47s;
    // the old bootstrap/install 30s loops could each spend 60s inside one request.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(90);
    let mut attempts = 0;
    let mut last = "no response".to_owned();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "People readiness deadline waiting for {expected}; last: {last}\n{}",
            fs::read_to_string(server_log).unwrap_or_default()
        );
        attempts += 1;
        // Keep cold compilation serial. Short timed-out probes can leave a compile
        // running on the server and start another one on the next request.
        match client
            .get(format!("{origin}/api/m/people/people"))
            .header("origin", origin)
            .header("cookie", cookie)
            .timeout(remaining)
            .send()
        {
            Ok(response) => {
                let status = response.status().as_u16();
                if status == expected {
                    println!(
                        "People ready: HTTP {status} after {:?}, {attempts} probe(s)",
                        started.elapsed()
                    );
                    return;
                }
                // Only host-not-yet-open is transient. Authentication, permission,
                // guest failures and overload must still fail the gate immediately.
                assert_eq!(
                    status,
                    503,
                    "Unexpected People readiness response, expected {expected}\n{}",
                    fs::read_to_string(server_log).unwrap_or_default()
                );
                last = format!("HTTP {status}");
            }
            Err(error) if error.is_connect() => last = "connection not yet available".into(),
            Err(error) => panic!(
                "People readiness request failed after {:?}: {error}\n{}",
                started.elapsed(),
                fs::read_to_string(server_log).unwrap_or_default()
            ),
        }
        thread::sleep(
            Duration::from_millis(500).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}
