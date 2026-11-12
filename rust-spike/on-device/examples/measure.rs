//! Prints peak memory (Linux) after loading the model and after a very long input.
//! Usage: measure <model-folder>
use moss_on_device::Engine;

fn kib(field: &str) -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find(|l| l.starts_with(field))
        .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        .unwrap_or(0)
}

fn main() {
    let folder = std::env::args().nth(1).expect("model folder");
    println!("start rss_mb {}", kib("VmRSS:") / 1024);
    let mut engine = Engine::load(std::path::Path::new(&folder)).unwrap();
    println!("loaded rss_mb {} peak_mb {}", kib("VmRSS:") / 1024, kib("VmHWM:") / 1024);
    engine.embed("search_query: hello").unwrap();
    println!("short rss_mb {} peak_mb {}", kib("VmRSS:") / 1024, kib("VmHWM:") / 1024);
    let long = "the quick brown fox jumps over the lazy dog ".repeat(2000);
    let t = std::time::Instant::now();
    engine.embed(&format!("search_document: {long}")).unwrap();
    println!("long rss_mb {} peak_mb {} seconds {:.2}", kib("VmRSS:") / 1024, kib("VmHWM:") / 1024, t.elapsed().as_secs_f64());
}
