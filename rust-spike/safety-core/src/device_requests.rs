//! Which companion device made each in-flight request. The gate fills it after it resolves a
//! device credential, and modules read it by request id. It holds ids only, never a credential,
//! and the gate removes the entry when the request ends.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct DeviceRequests(Arc<Mutex<HashMap<String, Uuid>>>);

impl DeviceRequests {
    /// The one map for this process. The gate writes it and modules read it.
    pub fn shared() -> Self {
        static SHARED: std::sync::OnceLock<DeviceRequests> = std::sync::OnceLock::new();
        SHARED.get_or_init(DeviceRequests::default).clone()
    }

    pub fn insert(&self, request_id: &str, device_id: Uuid) {
        self.0.lock().expect("device map").insert(request_id.to_owned(), device_id);
    }

    pub fn get(&self, request_id: &str) -> Option<Uuid> {
        self.0.lock().expect("device map").get(request_id).copied()
    }

    pub fn remove(&self, request_id: &str) {
        self.0.lock().expect("device map").remove(request_id);
    }
}
