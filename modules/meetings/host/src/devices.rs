//! Which ring delivery devices may upload for an account. Device pairing is a separate part
//! that is not built, so this is a narrow port. The default admits every device.
use anyhow::Result;
use uuid::Uuid;

pub trait RingDevices: Send + Sync {
    /// `true` when `device_id` may upload recordings for `owner`.
    fn allowed(&self, owner: Uuid, device_id: &str) -> Result<bool>;
}

/// Used until pairing exists. The routes still require the signed-in owner.
pub struct AnyDevice;
impl RingDevices for AnyDevice {
    fn allowed(&self, _: Uuid, _: &str) -> Result<bool> {
        Ok(true)
    }
}
