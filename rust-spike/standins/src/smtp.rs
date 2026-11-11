//! A small hand-written SMTP submission line protocol: EHLO, AUTH PLAIN and LOGIN, MAIL, RCPT,
//! DATA, RSET, NOOP, QUIT. Accepted messages are recorded for the test to read.
//! Reply wording follows Postfix.

use crate::mail::{Io, SentMail, Shared};
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn b64(s: &str) -> Option<String> {
    STANDARD.decode(s.trim()).ok().and_then(|b| String::from_utf8(b).ok())
}

pub(crate) async fn serve(io: Box<dyn Io>, state: Shared) {
    let (r, mut w) = tokio::io::split(io);
    let mut r = BufReader::new(r);
    macro_rules! say {
        ($($a:tt)*) => { if w.write_all(format!($($a)*).as_bytes()).await.is_err() { return; } };
    }
    macro_rules! next {
        () => {{
            let mut l = String::new();
            match r.read_line(&mut l).await {
                Ok(n) if n > 0 => l.trim_end_matches(['\r', '\n']).to_string(),
                _ => return,
            }
        }};
    }
    say!("220 mail.example.com ESMTP Moss stand-in\r\n");
    let (mut authed, mut from, mut rcpts) = (false, None::<String>, Vec::<String>::new());
    loop {
        let line = next!();
        let (verb, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        match verb.to_ascii_uppercase().as_str() {
            "EHLO" | "HELO" => say!(
                "250-mail.example.com\r\n250-PIPELINING\r\n250-SIZE 35882577\r\n250-ENHANCEDSTATUSCODES\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n"
            ),
            "AUTH" => {
                let (mech, initial) = rest.split_once(' ').unwrap_or((rest, ""));
                let creds: Option<(String, String)> = match mech.to_ascii_uppercase().as_str() {
                    "PLAIN" => {
                        let blob = if initial.is_empty() {
                            say!("334 \r\n");
                            next!()
                        } else {
                            initial.to_string()
                        };
                        // authorization-id NUL user NUL password
                        b64(&blob).and_then(|d| {
                            let p: Vec<&str> = d.split('\0').collect();
                            (p.len() == 3).then(|| (p[1].to_string(), p[2].to_string()))
                        })
                    }
                    "LOGIN" => {
                        say!("334 VXNlcm5hbWU6\r\n");
                        let u = b64(&next!());
                        say!("334 UGFzc3dvcmQ6\r\n");
                        let p = b64(&next!());
                        u.zip(p)
                    }
                    _ => {
                        say!("504 5.5.4 Unrecognized authentication type\r\n");
                        continue;
                    }
                };
                let ok = {
                    let mut s = state.lock().unwrap();
                    s.smtp_auth_seen += 1;
                    creds.is_some_and(|(u, p)| u == s.username && p == s.password)
                };
                if ok {
                    authed = true;
                    say!("235 2.7.0 Authentication successful\r\n");
                } else {
                    say!("535 5.7.8 Error: authentication failed: authentication failure\r\n");
                }
            }
            "MAIL" => {
                if !authed {
                    say!("530 5.7.0 Authentication required\r\n");
                } else if state.lock().unwrap().smtp_quota_exceeded {
                    say!("550 5.4.5 Daily user sending limit exceeded.\r\n");
                } else {
                    from = Some(angle(rest));
                    rcpts.clear();
                    say!("250 2.1.0 Ok\r\n");
                }
            }
            "RCPT" => {
                if from.is_none() {
                    say!("503 5.5.1 Error: need MAIL command\r\n");
                } else {
                    rcpts.push(angle(rest));
                    say!("250 2.1.5 Ok\r\n");
                }
            }
            "DATA" => {
                if from.is_none() || rcpts.is_empty() {
                    say!("503 5.5.1 Error: need RCPT command\r\n");
                    continue;
                }
                say!("354 End data with <CR><LF>.<CR><LF>\r\n");
                let mut data = String::new();
                loop {
                    let l = next!();
                    if l == "." {
                        break;
                    }
                    // Undo dot-stuffing.
                    data += l.strip_prefix('.').filter(|_| l.starts_with("..")).unwrap_or(&l);
                    data += "\r\n";
                }
                let n = {
                    let mut s = state.lock().unwrap();
                    s.sent.push(SentMail { from: from.take().unwrap(), recipients: std::mem::take(&mut rcpts), data });
                    s.sent.len()
                };
                say!("250 2.0.0 Ok: queued as STANDIN{n:05}\r\n");
            }
            "RSET" => {
                from = None;
                rcpts.clear();
                say!("250 2.0.0 Ok\r\n");
            }
            "NOOP" => say!("250 2.0.0 Ok\r\n"),
            "QUIT" => {
                say!("221 2.0.0 Bye\r\n");
                return;
            }
            _ => say!("502 5.5.2 Error: command not recognized\r\n"),
        }
    }
}

/// Pulls the address out of `FROM:<a@example.com> SIZE=12`.
fn angle(rest: &str) -> String {
    match (rest.find('<'), rest.find('>')) {
        (Some(a), Some(b)) if b > a => rest[a + 1..b].to_string(),
        _ => rest.trim().to_string(),
    }
}
