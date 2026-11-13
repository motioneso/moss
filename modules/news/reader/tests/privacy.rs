//! Privacy proofs for a library that holds no data of its own.
//!
//! The crate has no tables, so there is no row-level security here. What it can promise is that it
//! keeps nothing between calls, so one person's feed text can never show up in another person's
//! result, and that it has no way to write private text to a log, a file or the network.

use moss_news_reader::*;
use std::path::Path;

const PERSON_A_MARKER: &str = "ZEBRA-MARKER-7731-person-a";

fn person_a_feed() -> String {
    format!(
        "<rss version=\"2.0\"><channel><title>A</title>\
         <item><title>{PERSON_A_MARKER} headline</title>\
         <link>https://example.com/{PERSON_A_MARKER}</link>\
         <description>{PERSON_A_MARKER} summary</description></item></channel></rss>"
    )
}

fn person_b_feed() -> String {
    "<rss version=\"2.0\"><channel><title>B</title>\
     <item><title>Bee headline</title><link>https://example.org/bee</link></item></channel></rss>"
        .to_string()
}

#[test]
fn a_second_person_never_sees_the_first_persons_text() {
    let b_alone = to_feed_items(&person_b_feed(), &[]);
    assert_eq!(b_alone.len(), 1);

    let a = person_a_feed();
    let b = person_b_feed();
    let handles: Vec<_> = (0..8)
        .map(|n| {
            let (a, b) = (a.clone(), b.clone());
            std::thread::spawn(move || {
                let mut leaked = Vec::new();
                for _ in 0..200 {
                    let a_items = to_feed_items(&a, &[]);
                    assert_eq!(a_items.len(), 1, "thread {n}");
                    // A document with no items must come back empty, never with A's leftovers.
                    let empty = to_feed_items("<rss><channel></channel></rss>", &[]);
                    let junk = parse_public_feed_items("<html>not a feed</html>");
                    let b_items = to_feed_items(&b, &[]);
                    let reddit = parse_reddit_feed("<html>blocked</html>", "nfl", &RedditReaderOptions::default());
                    let dump = format!("{empty:?}{junk:?}{b_items:?}{reddit:?}");
                    if dump.contains(PERSON_A_MARKER) {
                        leaked.push(dump);
                    }
                }
                leaked
            })
        })
        .collect();
    for h in handles {
        let leaked = h.join().expect("thread");
        assert!(leaked.is_empty(), "person A text reached person B: {:?}", leaked.first());
    }
    assert_eq!(to_feed_items(&person_b_feed(), &[]), b_alone);
}

fn rust_sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![];
    for entry in std::fs::read_dir(dir).expect("src dir") {
        let path = entry.expect("entry").path();
        if path.extension().is_some_and(|e| e == "rs") {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            out.push((name, std::fs::read_to_string(&path).expect("read")));
        }
    }
    out
}

#[test]
fn the_source_has_no_way_to_log_store_or_send_text() {
    let forbidden = [
        "println!", "eprintln!", "print!(", "eprint!(", "dbg!(", "std::fs", "std::net", "std::process",
        "std::env", "std::io::stdout", "std::io::stderr", "tracing::", "log::", "TcpStream", "File::",
        "static mut", "thread_local", "OnceLock", "OnceCell", "lazy_static", "Mutex", "RwLock",
        "unsafe ", "Command::", "panic!(", "unwrap()", "expect(",
    ];
    let mut hits = vec![];
    for (name, text) in rust_sources() {
        assert!(!text.contains("#[cfg(test)]"), "{name}: tests belong in tests/, not src/");
        for (n, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            // Spaces inside a macro call must not hide it.
            let squeezed: String = line.split_whitespace().collect();
            for word in forbidden {
                if line.contains(word) || squeezed.contains(&word.split_whitespace().collect::<String>()) {
                    hits.push(format!("{name}:{}: {word}", n + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "forbidden in library code:\n{}", hits.join("\n"));
}

#[test]
fn only_the_approved_libraries_are_used() {
    let manifest = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let section = manifest.split("[dependencies]").nth(1).unwrap().split("\n[").next().unwrap();
    let names: Vec<&str> = section
        .lines()
        .filter_map(|l| l.split('=').next())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
    let allowed = ["scraper", "quick-xml", "psl", "chrono", "serde"];
    for name in &names {
        assert!(allowed.contains(name), "unapproved library {name}");
    }
    for needed in ["scraper", "quick-xml", "psl"] {
        assert!(names.contains(&needed), "missing {needed}");
    }
}

#[test]
fn a_tag_with_tens_of_thousands_of_attributes_stays_fast() {
    let attrs: String = (0..40_000).map(|n| format!("a{n}=\"\" ")).collect();
    let xml = format!(
        "<rss><channel><item><title {attrs}>T</title><link>https://example.com</link></item></channel></rss>"
    );
    let started = std::time::Instant::now();
    let items = parse_public_feed_items(&xml);
    assert_eq!(items.len(), 1);
    assert!(started.elapsed().as_secs() < 2, "took {:?}", started.elapsed());
}
