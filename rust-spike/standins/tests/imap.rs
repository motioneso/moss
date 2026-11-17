mod common;
use common::*;
use moss_standins::{
    fixtures,
    mail::{MailConfig, MailStandIn},
    tls,
};

async fn plain() -> MailStandIn {
    MailStandIn::start(MailConfig::default()).await
}

async fn logged_in(s: &MailStandIn) -> Client {
    let mut c = connect_plain(s.imap_addr).await;
    assert!(c.line().await.starts_with("* OK"));
    let r = c.imap("a1", "LOGIN \"bob@example.com\" \"correct-horse-battery\"").await;
    assert!(r.last().unwrap().starts_with("a1 OK"), "{r:?}");
    c
}

#[tokio::test]
async fn login_succeeds_with_the_right_password() {
    let s = plain().await;
    let _ = logged_in(&s).await;
}

#[tokio::test]
async fn wrong_password_is_refused_with_authenticationfailed() {
    let s = plain().await;
    let mut c = connect_plain(s.imap_addr).await;
    c.line().await;
    let r = c.imap("a1", "LOGIN \"bob@example.com\" \"not-the-password\"").await;
    assert_eq!(r.last().unwrap(), "a1 NO [AUTHENTICATIONFAILED] Authentication failed.");
    // A refused login does not open the mailbox.
    let r = c.imap("a2", "LIST \"\" \"*\"").await;
    assert_eq!(r.last().unwrap(), "a2 BAD Command received in Invalid state.");
}

#[tokio::test]
async fn throttled_login_returns_the_connection_limit_alert() {
    let s = plain().await;
    s.throttle_imap_login(true);
    let mut c = connect_plain(s.imap_addr).await;
    c.line().await;
    let r = c.imap("a1", "LOGIN \"bob@example.com\" \"correct-horse-battery\"").await;
    assert_eq!(r.last().unwrap(), "a1 NO [ALERT] Too many simultaneous connections. (Failure)");
}

#[tokio::test]
async fn lists_folders_with_special_use_attributes() {
    let s = plain().await;
    let mut c = logged_in(&s).await;
    let r = c.imap("a2", "LIST \"\" \"*\"").await;
    assert!(r.contains(&"* LIST (\\HasNoChildren) \"/\" \"INBOX\"".to_string()), "{r:?}");
    assert!(r.contains(&"* LIST (\\HasNoChildren \\Sent) \"/\" \"Sent\"".to_string()), "{r:?}");
}

#[tokio::test]
async fn select_reports_counts_and_uid_state() {
    let s = plain().await;
    s.add_message("INBOX", fixtures::MAIL_AGENDA);
    s.add_message("INBOX", fixtures::MAIL_LUNCH);
    let mut c = logged_in(&s).await;
    let r = c.imap("a2", "SELECT INBOX").await;
    assert!(r.contains(&"* 2 EXISTS".to_string()), "{r:?}");
    assert!(r.iter().any(|l| l.starts_with("* OK [UIDVALIDITY 1700000001]")));
    assert!(r.iter().any(|l| l.starts_with("* OK [UIDNEXT 3]")));
    assert!(r.last().unwrap().starts_with("a2 OK [READ-WRITE]"));
    let r = c.imap("a3", "SELECT Nope").await;
    assert_eq!(r.last().unwrap(), "a3 NO [NONEXISTENT] Mailbox doesn't exist: Nope");
}

#[tokio::test]
async fn fetch_returns_the_full_message_and_the_header_alone() {
    let s = plain().await;
    s.add_message("INBOX", fixtures::MAIL_AGENDA);
    let mut c = logged_in(&s).await;
    c.imap("a2", "SELECT INBOX").await;
    let r = c.imap("a3", "UID FETCH 1 (UID FLAGS BODY.PEEK[])").await;
    assert!(r[0].starts_with("* 1 FETCH (UID 1 FLAGS () BODY[] {"), "{r:?}");
    assert!(r[0].contains("Subject: Thursday agenda"));
    assert!(r[0].contains("Hi Bob, the draft agenda"));
    let r = c.imap("a4", "UID FETCH 1 (BODY.PEEK[HEADER])").await;
    assert!(r[0].contains("Subject: Thursday agenda") && !r[0].contains("Hi Bob"), "{r:?}");
}

#[tokio::test]
async fn sync_sees_a_changed_message_and_a_deleted_one() {
    let s = plain().await;
    let a = s.add_message("INBOX", fixtures::MAIL_AGENDA);
    let b = s.add_message("INBOX", fixtures::MAIL_LUNCH);
    let _c = s.add_message("INBOX", fixtures::MAIL_INVOICE);
    let mut c = logged_in(&s).await;
    let sel = c.imap("a2", "SELECT INBOX").await;
    let high: u64 = sel.iter().find_map(|l| l.strip_prefix("* OK [HIGHESTMODSEQ ")).unwrap().split(']').next().unwrap().parse().unwrap();

    // One message changes (read), another disappears.
    s.set_flags("INBOX", a, &["\\Seen"]);
    s.delete_message("INBOX", b);

    let r = c.imap("a3", &format!("UID FETCH 1:* (FLAGS) (CHANGEDSINCE {high})")).await;
    assert_eq!(r.len(), 2, "only the changed message comes back: {r:?}");
    assert!(r[0].contains("UID 1 FLAGS (\\Seen)"), "{r:?}");

    let r = c.imap("a4", "UID SEARCH ALL").await;
    assert_eq!(r[0], "* SEARCH 1 3", "message 2 is gone: {r:?}");
    let r = c.imap("a5", "UID SEARCH UID 2:*").await;
    assert_eq!(r[0], "* SEARCH 3");
    let r = c.imap("a6", "UID SEARCH UNSEEN").await;
    assert_eq!(r[0], "* SEARCH 3");
}

#[tokio::test]
async fn store_and_expunge_remove_a_message() {
    let s = plain().await;
    s.add_message("INBOX", fixtures::MAIL_AGENDA);
    let mut c = logged_in(&s).await;
    c.imap("a2", "SELECT INBOX").await;
    let r = c.imap("a3", "UID STORE 1 +FLAGS (\\Deleted)").await;
    assert!(r[0].contains("FLAGS (\\Deleted)"), "{r:?}");
    let r = c.imap("a4", "EXPUNGE").await;
    assert_eq!(r[0], "* 1 EXPUNGE");
    let r = c.imap("a5", "UID SEARCH ALL").await;
    assert_eq!(r[0], "* SEARCH");
}

#[tokio::test]
async fn unknown_command_is_bad_and_logout_says_bye() {
    let s = plain().await;
    let mut c = logged_in(&s).await;
    let r = c.imap("a2", "FROBNICATE").await;
    assert_eq!(r[0], "a2 BAD Error in IMAP command received by server.");
    let r = c.imap("a3", "LOGOUT").await;
    assert_eq!(r[0], "* BYE Logging out");
}

#[tokio::test]
async fn tls_works_for_a_client_that_trusts_the_certificate() {
    let s = MailStandIn::start(MailConfig { tls: Some(&tls::SELF_SIGNED), ..Default::default() }).await;
    let mut c = connect_tls(s.imap_addr, tls::client_trusting(&tls::SELF_SIGNED), "localhost").await.unwrap();
    assert!(c.line().await.starts_with("* OK"));
    let r = c.imap("a1", "LOGIN \"bob@example.com\" \"correct-horse-battery\"").await;
    assert!(r.last().unwrap().starts_with("a1 OK"));
}

#[tokio::test]
async fn self_signed_certificate_is_refused_by_a_client_that_does_not_know_it() {
    let s = MailStandIn::start(MailConfig { tls: Some(&tls::SELF_SIGNED), ..Default::default() }).await;
    let err = connect_tls(s.imap_addr, tls::client_trusting_nothing(), "localhost").await.err().expect("handshake must fail");
    let text = format!("{err:?}");
    assert!(text.contains("UnknownIssuer"), "{text}");
    assert_eq!(s.imap_logins_seen(), 0, "no login is attempted over a failed handshake");
}

#[tokio::test]
async fn certificate_for_another_host_is_refused() {
    let s = MailStandIn::start(MailConfig { tls: Some(&tls::WRONG_HOST), ..Default::default() }).await;
    // The client trusts this very certificate, so only the name is wrong.
    let err = connect_tls(s.imap_addr, tls::client_trusting(&tls::WRONG_HOST), "localhost").await.err().expect("handshake must fail");
    let text = format!("{err:?}");
    assert!(text.contains("NotValidForName") || text.contains("NotValidForNameContext"), "{text}");
}
