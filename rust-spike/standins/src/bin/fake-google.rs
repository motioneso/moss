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
    std::future::pending::<()>().await;
}
