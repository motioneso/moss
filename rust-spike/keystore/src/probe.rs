//! Is there a keychain? Asks the D-Bus session bus for the Secret Service
//! (`org.freedesktop.secrets`), which GNOME Keyring and KWallet both provide.

use std::time::Duration;

use zbus::blocking::{connection, fdo::DBusProxy};
use zbus::names::BusName;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const SECRET_SERVICE: &str = "org.freedesktop.secrets";
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keychain {
    /// No session bus to ask, as on a server or a bare window manager.
    NoSessionBus(String),
    /// A session bus, but nothing provides the Secret Service or can start it.
    NotInstalled,
    /// The Secret Service answered.
    Working { already_running: bool },
    /// Something holds or can start the Secret Service, but it did not answer properly.
    Broken(String),
}

impl Keychain {
    /// Only a machine with no keychain may offer the key file, and only as the owner's choice.
    /// A keychain that is there but failing never leads to the file.
    pub fn allows_key_file(&self) -> bool {
        matches!(self, Keychain::NoSessionBus(_) | Keychain::NotInstalled)
    }
}

/// Probes the session bus this process was started with.
pub fn probe() -> Keychain {
    probe_with(connection::Builder::session())
}

/// Probes the bus at a given address.
pub fn probe_address(address: &str) -> Keychain {
    probe_with(connection::Builder::address(address))
}

fn probe_with(builder: zbus::Result<connection::Builder<'static>>) -> Keychain {
    let connection = match builder.and_then(|b| b.method_timeout(ANSWER_WITHIN).build()) {
        Ok(connection) => connection,
        Err(error) => return Keychain::NoSessionBus(error.to_string()),
    };

    // A bus that will not answer says nothing about the keychain, so it never offers the file.
    let bus_trouble = |error: zbus::fdo::Error| Keychain::Broken(format!("session bus: {error}"));
    let bus = match DBusProxy::new(&connection) {
        Ok(bus) => bus,
        Err(error) => return Keychain::Broken(format!("session bus: {error}")),
    };
    let name = BusName::try_from(SECRET_SERVICE).expect("valid bus name");
    let already_running = match bus.name_has_owner(name) {
        Ok(owned) => owned,
        Err(error) => return bus_trouble(error),
    };
    if !already_running {
        match bus.list_activatable_names() {
            Ok(names) if names.iter().any(|n| n.as_str() == SECRET_SERVICE) => {}
            Ok(_) => return Keychain::NotInstalled,
            Err(error) => return bus_trouble(error),
        }
    }

    // Every client starts with OpenSession. The "plain" algorithm stores and unlocks nothing,
    // and the session ends when this connection closes. It also starts an activatable service.
    let reply = connection.call_method(
        Some(SECRET_SERVICE),
        "/org/freedesktop/secrets",
        Some("org.freedesktop.Secret.Service"),
        "OpenSession",
        &("plain", Value::from("")),
    );
    match reply.and_then(|reply| reply.body().deserialize::<(OwnedValue, OwnedObjectPath)>()) {
        Ok(_) => Keychain::Working { already_running },
        Err(error) => Keychain::Broken(error.to_string()),
    }
}
