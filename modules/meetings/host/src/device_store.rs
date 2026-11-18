//! The signed-in account's own companion devices, read through the owner-only view. No
//! method returns a credential hash. Other modules reach devices only through `check_device`.
use crate::{
    capture::{Browser, CaptureAuthority, Native, Refusing},
    devices::RingDevices,
};
use access_context::AccessContext;
use anyhow::Result;
use safety_core::{
    db::{DataContext, Database},
    device_requests::DeviceRequests,
};
use serde::Serialize;
use uuid::Uuid;

const FIELDS: &str = "id, display_name, platform, app_version, os_version, \
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
    to_char(last_contact_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
    to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
    capability_revision";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: Uuid,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub os_version: String,
    pub created_at: String,
    pub last_contact_at: Option<String>,
    pub expires_at: String,
    pub capability_revision: Option<i32>,
}

impl Device {
    fn from_row(r: &tokio_postgres::Row) -> Self {
        Self {
            id: r.get(0),
            display_name: r.get(1),
            platform: r.get(2),
            app_version: r.get(3),
            os_version: r.get(4),
            created_at: r.get(5),
            last_contact_at: r.get(6),
            expires_at: r.get(7),
            capability_revision: r.get(8),
        }
    }
}

/// What a module may ask about a device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    ScreenHistory,
    Focus,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    Allowed { device_name: String },
    Refused(&'static str),
}

#[derive(Clone)]
pub struct DeviceStore {
    app: Database,
}

impl DeviceStore {
    pub fn new(app: Database) -> Self {
        Self { app }
    }

    async fn open(&self, owner: Uuid) -> Result<DataContext> {
        Ok(DataContext::open(&self.app, &AccessContext::new(owner, "meetings-devices")).await.map_err(|e| anyhow::anyhow!("{e:?}"))?)
    }

    pub async fn list(&self, owner: Uuid) -> Result<Vec<Device>> {
        let cx = self.open(owner).await?;
        let rows = cx
            .db()
            .query(&format!("SELECT {FIELDS} FROM app.companion_devices_owner ORDER BY created_at"), &[])
            .await?;
        cx.commit().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(rows.iter().map(Device::from_row).collect())
    }

    pub async fn get(&self, owner: Uuid, id: Uuid) -> Result<Option<Device>> {
        let cx = self.open(owner).await?;
        let row = cx
            .db()
            .query_opt(&format!("SELECT {FIELDS} FROM app.companion_devices_owner WHERE id = $1"), &[&id])
            .await?;
        cx.commit().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(row.as_ref().map(Device::from_row))
    }

    /// `false` when the device is not this account's.
    pub async fn rename(&self, owner: Uuid, id: Uuid, name: &str) -> Result<bool> {
        let cx = self.open(owner).await?;
        let done: bool = cx.db().query_one("SELECT app.companion_device_rename($1, $2)", &[&id, &name]).await?.get(0);
        cx.commit().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(done)
    }

    /// `false` when the device is not this account's.
    pub async fn heartbeat(&self, owner: Uuid, id: Uuid, app_version: &str, os_version: &str) -> Result<bool> {
        let cx = self.open(owner).await?;
        let done: bool = cx
            .db()
            .query_one("SELECT app.companion_device_heartbeat($1, $2, $3)", &[&id, &app_version, &os_version])
            .await?
            .get(0);
        cx.commit().await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(done)
    }

    /// The public API other modules call. Both uses need a linked Mac.
    pub async fn check_device(&self, owner: Uuid, device: Uuid, _use: Use) -> Result<Check> {
        Ok(match self.get(owner, device).await? {
            None => Check::Refused("unlinked"),
            Some(d) if d.platform != "macos" => Check::Refused("wrong_kind"),
            Some(d) => Check::Allowed { device_name: d.display_name },
        })
    }

    /// Runs a store call from a sync port on a fresh thread with its own runtime.
    fn block<T: Send + 'static>(
        &self,
        run: impl FnOnce(DeviceStore) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send>> + Send + 'static,
    ) -> Result<T> {
        let store = self.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(run(store))
        })
        .join()
        .map_err(|_| anyhow::anyhow!("device lookup panicked"))?
    }
}

/// Ring uploads are allowed for the account's own Android devices only.
impl RingDevices for DeviceStore {
    fn allowed(&self, owner: Uuid, device_id: &str) -> Result<bool> {
        let Ok(id) = Uuid::parse_str(device_id) else { return Ok(false) };
        Ok(self
            .block(move |s| Box::pin(async move { s.get(owner, id).await }))?
            .is_some_and(|d| d.platform == "android"))
    }
}

/// The paired Mac behind a native request, named by the gate's per-request map. Browser,
/// recording, model and grant answers belong to a later part and stay refused.
pub struct NativeAuthority {
    devices: DeviceStore,
    requests: DeviceRequests,
}

impl NativeAuthority {
    pub fn new(devices: DeviceStore, requests: DeviceRequests) -> Self {
        Self { devices, requests }
    }
}

impl CaptureAuthority for NativeAuthority {
    fn browser(&self, o: Uuid, r: &str) -> Result<Option<Browser>> {
        Refusing.browser(o, r)
    }
    fn native(&self, owner: Uuid, request_id: &str) -> Result<Option<Native>> {
        let Some(id) = self.requests.get(request_id) else { return Ok(None) };
        let found = self.devices.block(move |s| Box::pin(async move { s.get(owner, id).await }))?;
        Ok(found.filter(|d| d.platform == "macos").map(|d| Native {
            device_id: d.id.to_string(),
            device_name: d.display_name,
            capability_revision: d.capability_revision.unwrap_or(0) as i64,
            expires_at: d.expires_at,
        }))
    }
    fn recording(&self, o: Uuid, d: &str, r: i64) -> Result<Option<String>> {
        Refusing.recording(o, d, r)
    }
    fn processing_route(&self, o: Uuid) -> Result<Option<String>> {
        Refusing.processing_route(o)
    }
    fn grant_credential(&self, o: Uuid, r: &str) -> Result<Option<String>> {
        Refusing.grant_credential(o, r)
    }
}
