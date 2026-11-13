//! The Mac link check. Route requests carry no headers, so the paired-device credential is
//! checked behind this narrow port. Device pairing is a separate part that is not built, so the
//! default refuses every request.
use anyhow::Result;
use uuid::Uuid;

/// What the Mac behind an ingest request turned out to be.
pub enum Link {
    /// A paired Mac whose credential is valid.
    Device(Uuid),
    /// The account is waiting for approval.
    Pending,
    /// The account has been switched off.
    Deactivated,
    /// No valid paired Mac.
    None,
}

pub trait MacLinks: Send + Sync {
    /// Checks the Mac credential on this request. The implementation must also have set the
    /// actor from the user id inside the credential, so every later read is that person's own.
    fn resolve(&self, owner: Uuid, request_id: &str) -> Result<Link>;
}

/// Used until pairing exists. Nothing is allowed.
pub struct Refusing;
impl MacLinks for Refusing {
    fn resolve(&self, _: Uuid, _: &str) -> Result<Link> {
        Ok(Link::None)
    }
}
