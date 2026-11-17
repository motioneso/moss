//! Runs the stand-in Plaid as its own process, for a live run of the real server.
//! Usage: fake-plaid. Prints the endpoint. Commands on stdin: `finish` completes every open
//! bank page, `fail <number> <CODE>` makes one bank refuse, `paginate`, `mutate-once`.
use moss_standins::plaid::{router, PlaidConfig, PlaidStandIn};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_owned());
    let plaid = Arc::new(PlaidStandIn::new(PlaidConfig {
        client_id: env("FAKE_PLAID_CLIENT_ID", "client-invented"),
        secret: env("FAKE_PLAID_SECRET", "secret-invented"),
        marker: env("FAKE_PLAID_MARKER", "TOKENMARK"),
        private_marker: env("FAKE_PLAID_PRIVATE_MARKER", "PRIVATEMARK"),
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("endpoint http://{}", listener.local_addr().unwrap());
    let shared = plaid.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["finish"] => {
                    for link in shared.open_links() {
                        shared.complete_link(&link);
                    }
                }
                ["fail", n, code] => shared.fail_item(n.parse().unwrap_or(0), code),
                ["paginate"] => shared.paginate(),
                ["mutate-once"] => shared.mutate_once(),
                _ => {}
            }
        }
    });
    axum::serve(listener, router(plaid)).await.unwrap();
}
