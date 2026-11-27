//! Operating system key store adapters. One adapter per system, behind the custody trait.
//! Linux uses the Secret Service. macOS uses the Keychain. Windows uses DPAPI, which
//! protects the stored blob for the signed-in account only.

use crate::custody::{CustodyError, MasterKey, OsKeyStore};

pub fn service_name(instance: &str) -> String {
    format!("moss-instance-{instance}")
}

#[cfg(target_os = "linux")]
pub fn platform_store() -> Box<dyn OsKeyStore + Send> {
    Box::new(linux::SecretServiceStore)
}

#[cfg(target_os = "macos")]
pub fn platform_store() -> Box<dyn OsKeyStore + Send> {
    Box::new(macos::KeychainStore)
}

#[cfg(target_os = "windows")]
pub fn platform_store() -> Box<dyn OsKeyStore + Send> {
    Box::new(windows::DpapiStore)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn platform_store() -> Box<dyn OsKeyStore + Send> {
    Box::new(UnsupportedStore)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
struct UnsupportedStore;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl OsKeyStore for UnsupportedStore {
    fn store_master(&mut self, _s: &str, _m: &MasterKey) -> Result<(), CustodyError> {
        Err(CustodyError::Unavailable(
            "no key store on this system".into(),
        ))
    }
    fn load_master(&self, _s: &str) -> Result<MasterKey, CustodyError> {
        Err(CustodyError::Unavailable(
            "no key store on this system".into(),
        ))
    }
    fn delete_master(&mut self, _s: &str) -> Result<(), CustodyError> {
        Err(CustodyError::Unavailable(
            "no key store on this system".into(),
        ))
    }
    fn probe(&self) -> Result<(), CustodyError> {
        Err(CustodyError::Unavailable(
            "no key store on this system".into(),
        ))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::collections::HashMap;
    use zbus::blocking::Connection;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    const SERVICE: &str = "org.freedesktop.secrets";
    const ROOT: &str = "/org/freedesktop/secrets";

    pub struct SecretServiceStore;

    fn locked_or_unavailable(error: zbus::Error) -> CustodyError {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("locked") || text.contains("islocked") {
            CustodyError::Locked
        } else if text.contains("serviceunknown")
            || text.contains("service unknown")
            || text.contains("was not provided by any")
            || text.contains("namehasowner") && text.contains("unknown")
        {
            // A bus with no Secret Service provider is no keychain session.
            CustodyError::NoSession
        } else {
            CustodyError::Unavailable(error.to_string())
        }
    }

    impl SecretServiceStore {
        fn session(&self) -> Result<(Connection, OwnedObjectPath), CustodyError> {
            let connection = Connection::session().map_err(|e| {
                if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
                    CustodyError::NoSession
                } else {
                    CustodyError::Unavailable(e.to_string())
                }
            })?;
            // The "plain" session sends the secret without extra encryption.
            // The session bus is private to this user account: only
            // processes running as the same user can connect to it, and the
            // keyring itself encrypts what it stores at rest.
            let reply = connection
                .call_method(
                    Some(SERVICE),
                    ROOT,
                    Some("org.freedesktop.Secret.Service"),
                    "OpenSession",
                    &("plain", Value::from("")),
                )
                .map_err(locked_or_unavailable)?;
            let (_, path): (OwnedValue, OwnedObjectPath) = reply
                .body()
                .deserialize()
                .map_err(|e: zbus::Error| CustodyError::Unavailable(e.to_string()))?;
            Ok((connection, path))
        }

        fn default_collection(connection: &Connection) -> Result<String, CustodyError> {
            let reply = connection
                .call_method(
                    Some(SERVICE),
                    ROOT,
                    Some("org.freedesktop.Secret.Service"),
                    "ReadAlias",
                    &("default",),
                )
                .map_err(locked_or_unavailable)?;
            let path: OwnedObjectPath = reply
                .body()
                .deserialize()
                .map_err(|e: zbus::Error| CustodyError::Unavailable(e.to_string()))?;
            if path.as_str().ends_with('/') {
                return Err(CustodyError::Unavailable(
                    "no default key store collection".into(),
                ));
            }
            // A locked collection refuses to start. A failed read is unavailable,
            // never unlocked.
            let locked_reply = connection
                .call_method(
                    Some(SERVICE),
                    path.as_str(),
                    Some("org.freedesktop.DBus.Properties"),
                    "Get",
                    &("org.freedesktop.Secret.Collection", "Locked"),
                )
                .map_err(locked_or_unavailable)?;
            let locked = locked_reply
                .body()
                .deserialize::<OwnedValue>()
                .ok()
                .and_then(|v| bool::try_from(v).ok())
                .ok_or_else(|| {
                    CustodyError::Unavailable(
                        "the key store did not report its locked state".into(),
                    )
                })?;
            if locked {
                return Err(CustodyError::Locked);
            }
            Ok(path.as_str().to_string())
        }

        fn find(
            &self,
            connection: &Connection,
            service: &str,
        ) -> Result<Option<String>, CustodyError> {
            let mut attributes: HashMap<&str, &str> = HashMap::new();
            attributes.insert("moss-service", service);
            let reply = connection
                .call_method(
                    Some(SERVICE),
                    ROOT,
                    Some("org.freedesktop.Secret.Service"),
                    "SearchItems",
                    &(attributes,),
                )
                .map_err(locked_or_unavailable)?;
            let (unlocked, locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) = reply
                .body()
                .deserialize()
                .map_err(|e: zbus::Error| CustodyError::Unavailable(e.to_string()))?;
            if !locked.is_empty() {
                return Err(CustodyError::Locked);
            }
            Ok(unlocked.first().map(|p| p.as_str().to_string()))
        }
    }

    impl OsKeyStore for SecretServiceStore {
        fn probe(&self) -> Result<(), CustodyError> {
            let (connection, _) = self.session()?;
            Self::default_collection(&connection).map(|_| ())
        }

        fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError> {
            let (connection, session) = self.session()?;
            let collection = Self::default_collection(&connection)?;
            let mut attributes: HashMap<&str, &str> = HashMap::new();
            attributes.insert("moss-service", service);
            let properties: HashMap<&str, Value> = HashMap::from([
                (
                    "org.freedesktop.Secret.Item.Label",
                    Value::from("Moss master key"),
                ),
                (
                    "org.freedesktop.Secret.Item.Attributes",
                    Value::from(attributes),
                ),
            ]);
            let secret: (OwnedObjectPath, Vec<u8>, Vec<u8>, &str) = (
                session.into(),
                Vec::new(),
                master.bytes().to_vec(),
                "application/octet-stream",
            );
            connection
                .call_method(
                    Some(SERVICE),
                    collection.as_str(),
                    Some("org.freedesktop.Secret.Collection"),
                    "CreateItem",
                    &(properties, secret, true),
                )
                .map_err(locked_or_unavailable)?;
            Ok(())
        }

        fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError> {
            let (connection, session) = self.session()?;
            let item = self
                .find(&connection, service)?
                .ok_or_else(|| CustodyError::NoMaster)?;
            let reply = connection
                .call_method(
                    Some(SERVICE),
                    item.as_str(),
                    Some("org.freedesktop.Secret.Item"),
                    "GetSecret",
                    &(session,),
                )
                .map_err(locked_or_unavailable)?;
            let secret: (OwnedObjectPath, Vec<u8>, Vec<u8>, String) = reply
                .body()
                .deserialize()
                .map_err(|e: zbus::Error| CustodyError::Unavailable(e.to_string()))?;
            let bytes: [u8; 32] = secret
                .2
                .try_into()
                .map_err(|_| CustodyError::Damaged("master key has the wrong size".into()))?;
            Ok(MasterKey::from_bytes(bytes))
        }

        fn delete_master(&mut self, service: &str) -> Result<(), CustodyError> {
            let (connection, _) = self.session()?;
            if let Some(item) = self.find(&connection, service)? {
                connection
                    .call_method(
                        Some(SERVICE),
                        item.as_str(),
                        Some("org.freedesktop.Secret.Item"),
                        "Delete",
                        &(),
                    )
                    .map_err(locked_or_unavailable)?;
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub struct KeychainStore;

    fn map(error: security_framework::base::Error) -> CustodyError {
        let code = error.code();
        // errSecInteractionNotAllowed and errSecAuthFailed mean the Keychain is locked.
        if code == -25308 || code == -25293 {
            CustodyError::Locked
        } else if code == -25300 {
            CustodyError::NoMaster
        } else {
            CustodyError::Unavailable(format!("Keychain error {code}"))
        }
    }

    impl OsKeyStore for KeychainStore {
        fn probe(&self) -> Result<(), CustodyError> {
            // A locked Keychain refuses a lookup with an interaction error.
            match get_generic_password("moss-master-key-probe", "probe") {
                Ok(_) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(error) => Err(map(error)),
            }
        }
        fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError> {
            set_generic_password(service, service, master.bytes()).map_err(map)
        }
        fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError> {
            let bytes = get_generic_password(service, service).map_err(map)?;
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| CustodyError::Damaged("master key has the wrong size".into()))?;
            Ok(MasterKey::from_bytes(bytes))
        }
        fn delete_master(&mut self, service: &str) -> Result<(), CustodyError> {
            match delete_generic_password(service, service) {
                Ok(()) => Ok(()),
                // Deleting an item that is already gone is success.
                Err(error) if error.code() == -25300 => Ok(()),
                Err(error) => Err(map(error)),
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    pub struct DpapiStore;

    fn store_folder() -> Result<PathBuf, CustodyError> {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        use windows_sys::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
        };
        let mut raw = std::ptr::null_mut();
        // Resolve the actual token's profile, not an environment inherited
        // from a different account when this process was launched.
        // SAFETY: the API writes an allocated, NUL-terminated UTF-16 path.
        let result = unsafe {
            SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, std::ptr::null_mut(), &mut raw)
        };
        if result < 0 || raw.is_null() {
            if !raw.is_null() {
                // SAFETY: this pointer was allocated by SHGetKnownFolderPath.
                unsafe { CoTaskMemFree(raw.cast()) };
            }
            return Err(CustodyError::Unavailable(
                "Windows could not open your account's key store folder. Sign out and in, then try again."
                    .into(),
            ));
        }
        // SAFETY: successful SHGetKnownFolderPath returns a NUL-terminated
        // string; copy it before freeing exactly its original allocation.
        let path = unsafe {
            let mut length = 0;
            while *raw.add(length) != 0 {
                length += 1;
            }
            let path = OsString::from_wide(std::slice::from_raw_parts(raw, length));
            CoTaskMemFree(raw.cast());
            PathBuf::from(path)
        };
        Ok(path.join("Moss/keystore"))
    }

    fn blob_path(dir: &Path, service: &str) -> PathBuf {
        let safe: String = service
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        dir.join(format!("{safe}.dpapi"))
    }

    fn protect(data: &[u8]) -> Result<Vec<u8>, CustodyError> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut out = CRYPT_INTEGER_BLOB::default();
            let ok = CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out,
            );
            if ok == 0 || out.pbData.is_null() {
                return Err(CustodyError::Unavailable(
                    "DPAPI could not protect the master key".into(),
                ));
            }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            windows_sys::Win32::Foundation::LocalFree(out.pbData as *mut _);
            Ok(bytes)
        }
    }

    fn unprotect(data: &[u8]) -> Result<Vec<u8>, CustodyError> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut out = CRYPT_INTEGER_BLOB::default();
            let ok = CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out,
            );
            if ok == 0 || out.pbData.is_null() {
                return Err(CustodyError::Unavailable(
                    "DPAPI could not unprotect the master key".into(),
                ));
            }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            windows_sys::Win32::Foundation::LocalFree(out.pbData as *mut _);
            Ok(bytes)
        }
    }

    impl OsKeyStore for DpapiStore {
        fn probe(&self) -> Result<(), CustodyError> {
            store_folder()?;
            protect(b"moss-probe").map(|_| ())
        }
        fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError> {
            let protected = protect(master.bytes())?;
            let dir = store_folder()?;
            std::fs::create_dir_all(&dir)
                .map_err(|e| CustodyError::Io(format!("create DPAPI folder: {e}")))?;
            // Stage beside the blob, then rename over it, so a crash mid-write
            // leaves the old protected blob whole.
            let target = blob_path(&dir, service);
            let staging = target.with_extension("staging");
            std::fs::write(&staging, STANDARD.encode(protected))
                .map_err(|e| CustodyError::Io(format!("write DPAPI staging file: {e}")))?;
            let renamed = crate::windows_replace::rename_sibling(&staging, &target);
            if renamed.is_err() {
                let _ = std::fs::remove_file(&staging);
            }
            renamed.map_err(|e| CustodyError::Io(format!("replace DPAPI blob: {e}")))
        }
        fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError> {
            let text = std::fs::read_to_string(blob_path(&store_folder()?, service))
                .map_err(|_| CustodyError::NoMaster)?;
            let protected = STANDARD
                .decode(text.trim())
                .map_err(|_| CustodyError::Damaged("DPAPI blob not readable".into()))?;
            let bytes = unprotect(&protected)?;
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| CustodyError::Damaged("master key has the wrong size".into()))?;
            Ok(MasterKey::from_bytes(bytes))
        }
        fn delete_master(&mut self, service: &str) -> Result<(), CustodyError> {
            let _ = std::fs::remove_file(blob_path(&store_folder()?, service));
            Ok(())
        }
    }
}
