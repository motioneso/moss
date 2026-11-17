//! Runs the stand-in Outlook page as its own process, for a live run of the real server.
//! Usage: fake-outlook. Prints the endpoint and the account address the page shows.
use moss_standins::outlook::{OutlookConfig, OutlookStandIn};

#[tokio::main]
async fn main() {
    let page = OutlookStandIn::start(OutlookConfig::default()).await;
    println!("endpoint {}", page.endpoint());
    println!("account person@example.invalid");
    page.add_event("e1", "Invented standup", "10 AM to 10:30 AM", 1);
    page.add_event("e2", "Invented review", "2 PM to 3 PM", 9);
    println!("events 2");
    // Commands on stdin: `sign-out` makes every later answer ask for sign-in.
    let page = std::sync::Arc::new(page);
    let shared = page.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if line.trim() == "sign-out" {
                shared.sign_out();
            }
        }
    });
    std::future::pending::<()>().await;
}
