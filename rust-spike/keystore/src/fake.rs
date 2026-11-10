//! A stand-in Secret Service for tests and the screenshot run. It takes the bus name, then
//! answers OpenSession properly, refuses it, or never answers.

use std::time::Duration;

use zbus::blocking::{connection, Connection};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::probe::SECRET_SERVICE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behaviour {
    Working,
    /// Holds the name but refuses every session with an error reply.
    Broken,
    /// Answers nothing until well after the probe gives up.
    Hangs,
}

struct Service;

#[zbus::interface(name = "org.freedesktop.Secret.Service")]
impl Service {
    fn open_session(&self, _algorithm: &str, _input: Value<'_>) -> (OwnedValue, OwnedObjectPath) {
        let path = OwnedObjectPath::try_from("/org/freedesktop/secrets/session/fake").unwrap();
        (OwnedValue::from(0u8), path)
    }
}

struct Refuses;

#[zbus::interface(name = "org.freedesktop.Secret.Service")]
impl Refuses {
    fn open_session(
        &self,
        _algorithm: &str,
        _input: Value<'_>,
    ) -> zbus::fdo::Result<(OwnedValue, OwnedObjectPath)> {
        Err(zbus::fdo::Error::Failed(
            "the keychain refused the session".to_string(),
        ))
    }
}

struct Silent;

#[zbus::interface(name = "org.freedesktop.Secret.Service")]
impl Silent {
    fn open_session(&self, _algorithm: &str, _input: Value<'_>) -> (OwnedValue, OwnedObjectPath) {
        std::thread::sleep(Duration::from_secs(20));
        Service.open_session(_algorithm, _input)
    }
}

/// Connects to the bus at `address` and holds the Secret Service name until dropped.
pub fn hold_secret_service(
    address: Option<&str>,
    behaviour: Behaviour,
) -> zbus::Result<Connection> {
    let builder = match address {
        Some(address) => connection::Builder::address(address)?,
        None => connection::Builder::session()?,
    };
    let builder = builder.name(SECRET_SERVICE)?;
    let builder = match behaviour {
        Behaviour::Working => builder.serve_at("/org/freedesktop/secrets", Service)?,
        Behaviour::Broken => builder.serve_at("/org/freedesktop/secrets", Refuses)?,
        Behaviour::Hangs => builder.serve_at("/org/freedesktop/secrets", Silent)?,
    };
    builder.build()
}
