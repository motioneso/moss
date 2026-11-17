//! Pure rules for usefulness feedback and proactive cards.
//!
//! Nothing here touches the database or the clock, so the same code runs natively and as
//! WebAssembly and the fixtures in [`fixtures`] prove both builds agree.

pub mod feedback;
pub mod fixtures;
pub mod proactive;
pub mod rule;

/// A refusal the route turns into an HTTP error reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reject {
    pub status: u16,
    pub message: String,
}

impl Reject {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Reject {
            status,
            message: message.into(),
        }
    }
}

/// Length as JavaScript counts it, in UTF-16 units, so limits match the old server.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `max` UTF-16 units of `text`, never splitting a character.
pub fn js_slice(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used > max {
            break;
        }
        out.push(c);
    }
    out
}

/// Runs every fixture and returns how many failed. Exported so a WebAssembly host can call it.
#[no_mangle]
pub extern "C" fn run_fixtures() -> u32 {
    fixtures::failures().len() as u32
}
