//! Is there a keychain? Asks the D-Bus session bus for the Secret Service
//! (`org.freedesktop.secrets`), which GNOME Keyring and KWallet both provide.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use zbus::address::transport::{Transport, Unix, UnixSocket};
use zbus::blocking::{connection, fdo::DBusProxy, Connection};
use zbus::names::BusName;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const SECRET_SERVICE: &str = "org.freedesktop.secrets";
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Keychain {
    /// No session bus to ask, as on a server or a bare window manager. Only an unset
    /// address with no socket in the runtime folder counts; a bus that is there but fails
    /// is `Broken`.
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
    let address = std::env::var("DBUS_SESSION_BUS_ADDRESS").ok().filter(|a| !a.is_empty());
    let folder = runtime_dir(std::env::var_os("XDG_RUNTIME_DIR"), unsafe { libc::geteuid() });
    probe_session(address.as_deref(), &folder)
}

/// The runtime folder `XDG_RUNTIME_DIR` names, else the login's usual one. An empty or relative
/// value is ignored, as the XDG spec asks, so it never points the bus check at the current folder.
pub fn runtime_dir(value: Option<OsString>, euid: u32) -> PathBuf {
    value
        .map(PathBuf::from)
        .filter(|folder| folder.is_absolute())
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{euid}")))
}

/// Finds the session bus the way D-Bus clients do: the address if one is set, else the `bus`
/// socket in the runtime folder. There is no session bus only when neither exists.
pub fn probe_session(address: Option<&str>, runtime_dir: &Path) -> Keychain {
    if let Some(address) = address {
        return probe_address(address);
    }
    let socket = runtime_dir.join("bus");
    match socket.symlink_metadata() {
        Ok(_) => probe_with(Ok(Transport::Unix(Unix::new(UnixSocket::File(socket))).into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Keychain::NoSessionBus(
            format!("no bus address is set and {} does not exist", socket.display()),
        ),
        Err(error) => Keychain::Broken(format!("{}: {error}", socket.display())),
    }
}

/// Probes the bus at a given address. A set address that cannot be reached is `Broken`.
pub fn probe_address(address: &str) -> Keychain {
    probe_with(address.parse())
}

/// Connects within `ANSWER_WITHIN`. The connection handshake has no timeout of its own, so it
/// runs on a thread that is left behind if the bus never answers.
fn connect(address: zbus::Result<zbus::Address>) -> Result<Connection, String> {
    let address = address.map_err(|error| error.to_string())?;
    let (send, answer) = mpsc::channel();
    std::thread::spawn(move || {
        let connection = connection::Builder::address(address)
            .and_then(|builder| builder.method_timeout(ANSWER_WITHIN).build());
        let _ = send.send(connection);
    });
    match answer.recv_timeout(ANSWER_WITHIN) {
        Ok(Ok(connection)) => Ok(connection),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!("no answer within {} s", ANSWER_WITHIN.as_secs())),
    }
}

fn probe_with(address: zbus::Result<zbus::Address>) -> Keychain {
    let connection = match connect(address) {
        Ok(connection) => connection,
        Err(error) => return Keychain::Broken(format!("session bus: {error}")),
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
