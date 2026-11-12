//! Runs the fake mail server as its own process, for a live run of the real server.
//! Usage: fake-mail <certificate-file>. Writes the test certificate to that file.
//!
//! The inbox starts with three recent messages. Lines on standard input change it later.
//! `replace <uid>` rewrites that message's body, and `delete <uid>` removes it.
use moss_standins::{
    mail::{MailConfig, MailStandIn},
    tls,
};
use std::time::{SystemTime, UNIX_EPOCH};
use std::io::BufRead;

/// Today as "D-Mon-YYYY" and the RFC 2822 date header text, from the clock.
fn today() -> (String, String) {
    let days = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month as usize - 1];
    (format!("{day}-{name}-{year}"), format!("{day} {name} {year}"))
}

fn message(subject: &str, body: &str, header_date: &str) -> String {
    format!(
        "From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: {subject}\r\nDate: {header_date} 09:15:00 +0000\r\nMessage-ID: <{}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n",
        subject.replace(' ', "-")
    )
}

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: fake-mail <certificate-file>");
    std::fs::write(&path, tls::SELF_SIGNED.cert_pem).expect("write certificate");
    let mail = std::sync::Arc::new(MailStandIn::start(MailConfig { tls: Some(&tls::SELF_SIGNED), ..Default::default() }).await);
    let (internal, header) = today();
    for (subject, body) in [
        ("Quarterly plan", "PLAN-BODY-SENTINEL the plan is attached."),
        ("Lunch on Friday", "LUNCH-BODY-SENTINEL are you free?"),
        ("Invoice reminder", "INVOICE-BODY-SENTINEL payment is due."),
    ] {
        mail.add_message_dated("INBOX", &message(subject, body, &header), &format!("{internal} 09:15:00 +0000"));
    }
    println!("imap-port {}", mail.imap_addr.port());
    println!("smtp-port {}", mail.smtp_addr.port());
    println!("username bob@example.com");
    println!("password correct-horse-battery");
    // Prints nothing more: the reader stops after the startup lines, and a later write would
    // hit a closed pipe and end this process.
    let handle = mail.clone();
    let commands = tokio::task::spawn_blocking(move || {
        let mail = handle;
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let mut words = line.split_whitespace();
        match (words.next(), words.next().and_then(|u| u.parse::<u32>().ok())) {
            (Some("replace"), Some(uid)) => {
                let raw = message("Quarterly plan", "CHANGED-BODY-SENTINEL the plan was rewritten with a much longer body.", &header);
                mail.replace_body("INBOX", uid, &raw);
            }
            (Some("delete"), Some(uid)) => mail.delete_message("INBOX", uid),
            _ => {}
        }
        }
    });
    let _ = commands.await;
    let _keep_alive = &mail;
    std::future::pending::<()>().await;
}
