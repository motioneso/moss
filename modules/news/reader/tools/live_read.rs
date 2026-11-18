//! Reads one live feed from standard input and prints what the reader makes of it.
//! Usage: curl -s <feed address> | cargo run --example live_read -- <feed|reddit>
use std::io::Read;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "feed".into());
    let mut body = String::new();
    std::io::stdin().read_to_string(&mut body).expect("read input");
    if mode == "reddit" {
        match moss_news_reader::parse_reddit_feed(&body, "x", &Default::default()) {
            None => println!("not a subreddit feed"),
            Some(feed) => {
                println!("subreddit {} - {} linked headlines", feed.subreddit.display_name, feed.headlines.len());
                for h in feed.headlines.iter().take(3) {
                    println!("  {} | {} | {}", h.publisher_domain, h.title, h.url);
                }
            }
        }
        return;
    }
    println!("is feed document: {}", moss_news_reader::is_public_feed_document(&body));
    let items = moss_news_reader::parse_public_feed_items(&body);
    println!("{} items", items.len());
    for item in items.iter().take(3) {
        println!("  {} | {:?} | {}", item.title, item.published_at, item.url);
    }
}
