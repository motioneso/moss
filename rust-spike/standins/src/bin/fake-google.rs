//! Runs the fake Google as its own process, for a live run of the real server.
//! Usage: fake-google <code>. It accepts <code> once as an authorization code.
use moss_standins::google::{GoogleConfig, GoogleStandIn};

#[tokio::main]
async fn main() {
    let code = std::env::args().nth(1).unwrap_or_else(|| "live-proof-code".into());
    let google = GoogleStandIn::start(GoogleConfig::default()).await;
    google.issue_code(&code);
    println!("token-url {}", google.token_url());
    println!("client-id fake-client-id.apps.example.com");
    println!("client-secret fake-client-secret");
    println!("code {code}");
    std::future::pending::<()>().await;
}
