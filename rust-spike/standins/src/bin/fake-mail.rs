//! Runs the fake mail server as its own process, for a live run of the real server.
//! Usage: fake-mail <certificate-file>. Writes the test certificate to that file.
use moss_standins::{
    mail::{MailConfig, MailStandIn},
    tls,
};

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: fake-mail <certificate-file>");
    std::fs::write(&path, tls::SELF_SIGNED.cert_pem).expect("write certificate");
    let mail = MailStandIn::start(MailConfig { tls: Some(&tls::SELF_SIGNED), ..Default::default() }).await;
    println!("imap-port {}", mail.imap_addr.port());
    println!("smtp-port {}", mail.smtp_addr.port());
    println!("username bob@example.com");
    println!("password correct-horse-battery");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        println!("imap-logins {} smtp-auths {}", mail.imap_logins_seen(), mail.smtp_auth_seen());
    }
}
