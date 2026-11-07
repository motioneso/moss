//! Holds the Secret Service name on a session bus, for tests and the screenshot run.
//!
//!   fake-secret-service --working | --broken | --hangs

use keystore::fake::{hold_secret_service, Behaviour};

fn main() {
    let behaviour = match std::env::args().nth(1).as_deref() {
        Some("--working") => Behaviour::Working,
        Some("--broken") => Behaviour::Broken,
        Some("--hangs") => Behaviour::Hangs,
        _ => {
            eprintln!("usage: fake-secret-service --working | --broken | --hangs");
            std::process::exit(2);
        }
    };
    // A bus starting this program on demand passes its own address.
    let address = std::env::var("DBUS_STARTER_ADDRESS").ok();
    let held = hold_secret_service(address.as_deref(), behaviour).expect("bus reachable");

    // Runs until the bus closes, so a test's bus takes its keychain with it.
    for _ in zbus::blocking::MessageIterator::from(&held) {}
}
