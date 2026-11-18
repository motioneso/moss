//! The mail login test against the stand-in IMAP and SMTP servers. No database needed.
use moss_connectors_host::mail_probe::{probe, Outcome, Servers, Smtp, Trust};
use moss_standins::{
    mail::{MailConfig, MailStandIn},
    tls::{self, Identity},
};
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};

const USER: &str = "bob@example.com";
const PASSWORD: &str = "correct-horse-battery";

fn der(id: &Identity) -> Vec<u8> {
    CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap().to_vec()
}

async fn stand_in(tls: Option<&'static Identity>, password: &str) -> MailStandIn {
    MailStandIn::start(MailConfig { username: USER.into(), password: password.into(), tls }).await
}

fn servers(imap: &MailStandIn, smtp: &MailStandIn, tls: bool) -> Servers {
    Servers {
        imap_host: "127.0.0.1".into(),
        imap_port: imap.imap_addr.port(),
        imap_tls: tls,
        smtp_host: "127.0.0.1".into(),
        smtp_port: smtp.smtp_addr.port(),
        smtp_security: if tls { Smtp::ImplicitTls } else { Smtp::None },
    }
}

fn trusting(ids: &[&Identity]) -> Trust {
    Trust { only: Some(ids.iter().map(|i| der(i)).collect()) }
}

#[tokio::test]
async fn a_good_login_reaches_both_servers_over_tls() {
    let s = stand_in(Some(&tls::SELF_SIGNED), PASSWORD).await;
    let out = probe(&servers(&s, &s, true), &trusting(&[&tls::SELF_SIGNED]), USER, PASSWORD).await;
    assert_eq!(out, Outcome::Ok);
    assert_eq!(s.imap_logins_seen(), 1);
    assert_eq!(s.smtp_auth_seen(), 1, "the sending server was signed in to, not just reached");
}

#[tokio::test]
async fn a_plain_server_without_starttls_still_works() {
    let s = stand_in(None, PASSWORD).await;
    let out = probe(&servers(&s, &s, false), &Trust { only: Some(vec![]) }, USER, PASSWORD).await;
    assert_eq!(out, Outcome::Ok);
}

#[tokio::test]
async fn a_wrong_password_is_told_apart_on_each_server() {
    let s = stand_in(Some(&tls::SELF_SIGNED), PASSWORD).await;
    let t = trusting(&[&tls::SELF_SIGNED]);
    assert_eq!(probe(&servers(&s, &s, true), &t, USER, "nope").await, Outcome::AuthFailed);
    assert_eq!(s.smtp_auth_seen(), 0, "the sending server is not tried after the mail server refuses");
    // The mail server accepts the login and only the sending server refuses it.
    let other = stand_in(Some(&tls::SELF_SIGNED), "another-password").await;
    assert_eq!(probe(&servers(&s, &other, true), &t, USER, PASSWORD).await, Outcome::AuthFailed);
    assert_eq!(other.smtp_auth_seen(), 1);
}

#[tokio::test]
async fn a_connection_limit_reads_as_a_refused_login() {
    let s = stand_in(Some(&tls::SELF_SIGNED), PASSWORD).await;
    s.throttle_imap_login(true);
    let out = probe(&servers(&s, &s, true), &trusting(&[&tls::SELF_SIGNED]), USER, PASSWORD).await;
    assert_eq!(out, Outcome::AuthFailed);
}

#[tokio::test]
async fn certificate_problems_are_told_apart_from_an_unreachable_server() {
    let good = stand_in(Some(&tls::SELF_SIGNED), PASSWORD).await;
    let wrong_host = stand_in(Some(&tls::WRONG_HOST), PASSWORD).await;
    // A certificate nobody trusts.
    let nothing = Trust { only: Some(vec![]) };
    assert_eq!(probe(&servers(&good, &good, true), &nothing, USER, PASSWORD).await, Outcome::TlsFailed);
    // A trusted certificate made for another host name.
    let both = trusting(&[&tls::SELF_SIGNED, &tls::WRONG_HOST]);
    assert_eq!(probe(&servers(&wrong_host, &good, true), &both, USER, PASSWORD).await, Outcome::TlsFailed);
    // The mail server is fine and only the sending server has the bad certificate.
    assert_eq!(probe(&servers(&good, &wrong_host, true), &both, USER, PASSWORD).await, Outcome::TlsFailed);
    // Nothing listens.
    let mut closed = servers(&good, &good, true);
    closed.imap_port = 1;
    assert_eq!(probe(&closed, &both, USER, PASSWORD).await, Outcome::Unreachable);
}
