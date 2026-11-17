//! Runs every golden case from the old reader and a personal-data scan of the fixtures.

mod parity_checks;

fn scan_fixtures() -> Vec<String> {
    let mut found = vec![];
    for (name, text) in parity_checks::FIXTURES {
        for (i, ch) in text.char_indices() {
            if ch == '@' {
                let around: String = text[i.saturating_sub(20)..(i + 20).min(text.len())].to_string();
                found.push(format!("{name}: at-sign near {around:?}"));
            }
        }
        for token in text.split(|c: char| !(c.is_ascii_digit() || c == '-' || c == '+' || c == ' ' || c == '(' || c == ')')) {
            let digits = token.chars().filter(|c| c.is_ascii_digit()).count();
            let starts_like_number = token.starts_with(|c: char| c.is_ascii_digit() || c == '+' || c == '(');
            if digits >= 10 && starts_like_number && token.contains(|c| c == '-' || c == ' ' || c == '(') {
                found.push(format!("{name}: phone-like {token:?}"));
            }
        }
        for lan in ["192.168.", "10.0.", "172.16.", ".local", "localhost", "tailscale", ".ts.net"] {
            if text.contains(lan) {
                found.push(format!("{name}: private address {lan}"));
            }
        }
        if text.contains("<dc:creator>") || text.contains("<author>") {
            found.push(format!("{name}: author byline left in"));
        }
    }
    found
}

fn main() {
    let report = parity_checks::run_all();
    let scan = scan_fixtures();
    println!("parity: {} cases checked, {} differ", report.checked, report.failures.len());
    for f in &report.failures {
        println!("DIFF {f}");
    }
    for f in &scan {
        println!("PERSONAL DATA {f}");
    }
    if !report.failures.is_empty() || !scan.is_empty() || report.checked < 400 {
        std::process::exit(1);
    }
}
