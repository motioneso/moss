mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use common::*;
use moss_standins::{
    mail::{MailConfig, MailStandIn},
    tls,
};

fn plain_auth(user: &str, pass: &str) -> String {
    format!("AUTH PLAIN {}", STANDARD.encode(format!("\0{user}\0{pass}")))
}

async fn ready(s: &MailStandIn) -> Client {
    let mut c = connect_plain(s.smtp_addr).await;
    assert!(c.line().await.starts_with("220 "));
    let r = c.smtp("EHLO client.example.com").await;
    assert!(r.last().unwrap().contains("AUTH PLAIN LOGIN"), "{r:?}");
    c
}

#[tokio::test]
async fn wrong_password_gets_535() {
    let s = MailStandIn::start(MailConfig::default()).await;
    let mut c = ready(&s).await;
    let r = c.smtp(&plain_auth("bob@example.com", "wrong")).await;
    assert_eq!(r, vec!["535 5.7.8 Error: authentication failed: authentication failure"]);
    let r = c.smtp("MAIL FROM:<bob@example.com>").await;
    assert_eq!(r, vec!["530 5.7.0 Authentication required"]);
}

#[tokio::test]
async fn login_mechanism_works_and_send_is_recorded() {
    let s = MailStandIn::start(MailConfig::default()).await;
    let mut c = ready(&s).await;
    assert_eq!(c.smtp("AUTH LOGIN").await, vec!["334 VXNlcm5hbWU6"]);
    assert_eq!(c.smtp(&STANDARD.encode("bob@example.com")).await, vec!["334 UGFzc3dvcmQ6"]);
    assert_eq!(c.smtp(&STANDARD.encode("correct-horse-battery")).await, vec!["235 2.7.0 Authentication successful"]);
    assert_eq!(c.smtp("MAIL FROM:<bob@example.com>").await, vec!["250 2.1.0 Ok"]);
    assert_eq!(c.smtp("RCPT TO:<alice@example.com>").await, vec!["250 2.1.5 Ok"]);
    assert_eq!(c.smtp("RCPT TO:<carol@example.com>").await, vec!["250 2.1.5 Ok"]);
    assert!(c.smtp("DATA").await[0].starts_with("354 "));
    c.send("Subject: Re: Thursday agenda\r\n\r\n..a line that starts with a dot\r\nBye").await;
    let r = c.smtp(".").await;
    assert_eq!(r, vec!["250 2.0.0 Ok: queued as STANDIN00001"]);
    assert_eq!(c.smtp("QUIT").await, vec!["221 2.0.0 Bye"]);

    let sent = s.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].from, "bob@example.com");
    assert_eq!(sent[0].recipients, vec!["alice@example.com", "carol@example.com"]);
    assert!(sent[0].data.contains("Subject: Re: Thursday agenda"));
    assert!(sent[0].data.contains("\r\n.a line that starts with a dot\r\n"), "dot-stuffing removed: {:?}", sent[0].data);
}

#[tokio::test]
async fn daily_limit_is_refused_at_mail_from() {
    let s = MailStandIn::start(MailConfig::default()).await;
    s.smtp_quota_exceeded(true);
    let mut c = ready(&s).await;
    assert_eq!(c.smtp(&plain_auth("bob@example.com", "correct-horse-battery")).await[0][..3], *"235");
    assert_eq!(c.smtp("MAIL FROM:<bob@example.com>").await, vec!["550 5.4.5 Daily user sending limit exceeded."]);
    assert!(s.sent().is_empty());
}

#[tokio::test]
async fn out_of_order_commands_get_503_and_unknown_get_502() {
    let s = MailStandIn::start(MailConfig::default()).await;
    let mut c = ready(&s).await;
    assert_eq!(c.smtp("RCPT TO:<alice@example.com>").await, vec!["503 5.5.1 Error: need MAIL command"]);
    assert_eq!(c.smtp("DATA").await, vec!["503 5.5.1 Error: need RCPT command"]);
    assert_eq!(c.smtp("VRFY alice").await, vec!["502 5.5.2 Error: command not recognized"]);
}

#[tokio::test]
async fn tls_certificate_cases_match_imap() {
    let s = MailStandIn::start(MailConfig { tls: Some(&tls::SELF_SIGNED), ..Default::default() }).await;
    let mut c = connect_tls(s.smtp_addr, tls::client_trusting(&tls::SELF_SIGNED), "localhost").await.unwrap();
    assert!(c.line().await.starts_with("220 "));
    let err = connect_tls(s.smtp_addr, tls::client_trusting_nothing(), "localhost").await.err().expect("must fail");
    assert!(format!("{err:?}").contains("UnknownIssuer"));
}
