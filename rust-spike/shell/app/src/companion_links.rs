//! Connects Backtrack's Mac check to the device store. The shell is the only place that knows
//! both modules, so neither imports the other.
use anyhow::Result;
use moss_backtrack_host::link::{Link, MacLinks};
use moss_meetings_host::device_store::{Check, DeviceStore, Use};
use safety_core::device_requests::DeviceRequests;
use uuid::Uuid;

/// Answers from the device the gate resolved for this request. Without a device, or when the
/// device store says no, Backtrack sees no linked Mac and refuses the upload.
pub struct StoreLinks {
    pub devices: DeviceStore,
    pub requests: DeviceRequests,
}

impl MacLinks for StoreLinks {
    fn resolve(&self, owner: Uuid, request_id: &str) -> Result<Link> {
        let Some(device) = self.requests.get(request_id) else { return Ok(Link::None) };
        Ok(match self.devices.check_device_blocking(owner, device, Use::ScreenHistory)? {
            Check::Allowed { .. } => Link::Device(device),
            Check::Refused(_) => Link::None,
        })
    }
}
