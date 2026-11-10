//! Native desktop integration using existing dependencies and operating-system APIs.

use crate::store::{private_dir, Store};
use moss_network::config::{private_read, private_write};
use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub notifications: bool,
}

impl Preferences {
    pub fn load(store: &Store) -> Result<Self, String> {
        let path = store.data.join("app/desktop.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        serde_json::from_slice(&private_read(&path)?)
            .map_err(|_| "Cannot read desktop settings".into())
    }

    pub fn save(&self, store: &Store) -> Result<(), String> {
        private_dir(&store.data)?;
        private_dir(&store.data.join("app"))?;
        private_write(
            &store.data.join("app/desktop.json"),
            &serde_json::to_vec(self).map_err(|_| "Cannot save desktop settings")?,
        )
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gio::glib::{variant::ToVariant, Variant};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    const ITEM: &str = "org.kde.StatusNotifierItem";
    const XML: &str = r#"<node><interface name="org.kde.StatusNotifierItem">
      <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
      <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
      <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
      <property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
      <property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
      <property name="IconName" type="s" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
    </interface></node>"#;

    pub struct Tray {
        connection: gio::DBusConnection,
        registration: Option<gio::RegistrationId>,
        watcher: Option<gio::SignalSubscriptionId>,
        host: Option<gio::SignalSubscriptionId>,
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            if let Some(id) = self.host.take() {
                self.connection.signal_unsubscribe(id);
            }
            if let Some(id) = self.watcher.take() {
                self.connection.signal_unsubscribe(id);
            }
            if let Some(id) = self.registration.take() {
                let _ = self.connection.unregister_object(id);
            }
        }
    }

    pub fn tray(proxy: tao::event_loop::EventLoopProxy<crate::UserEvent>) -> Option<Tray> {
        let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
        // A watcher may exist without any visible tray host. In that case Close must quit.
        let reply = connection
            .call_sync(
                Some("org.kde.StatusNotifierWatcher"),
                "/StatusNotifierWatcher",
                "org.freedesktop.DBus.Properties",
                "Get",
                Some(
                    &(
                        "org.kde.StatusNotifierWatcher",
                        "IsStatusNotifierHostRegistered",
                    )
                        .to_variant(),
                ),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                gio::Cancellable::NONE,
            )
            .ok()?;
        if !reply.get::<(Variant,)>()?.0.get::<bool>()? {
            return None;
        }
        let info = gio::DBusNodeInfo::for_xml(XML)
            .ok()?
            .lookup_interface(ITEM)?;
        let events = proxy.clone();
        let events_host = proxy.clone();
        let registration = connection
            .register_object(
                "/StatusNotifierItem",
                &info,
                move |_, _, _, _, method, _, invocation| {
                    let event = match method {
                        "Activate" | "SecondaryActivate" => crate::UserEvent::Reveal,
                        "ContextMenu" => crate::UserEvent::Desktop,
                        _ => {
                            invocation.return_dbus_error(
                                "org.freedesktop.DBus.Error.UnknownMethod",
                                "Unknown action",
                            );
                            return;
                        }
                    };
                    let _ = proxy.send_event(event);
                    invocation.return_value(None);
                },
                |_, _, _, _, property| match property {
                    "Category" => "ApplicationStatus".to_variant(),
                    "Id" => "moss".to_variant(),
                    "Title" => "Moss".to_variant(),
                    "Status" => "Active".to_variant(),
                    "IconName" => "applications-office".to_variant(),
                    "ItemIsMenu" => false.to_variant(),
                    _ => "".to_variant(),
                },
                |_, _, _, _, _, _| false,
            )
            .ok()?;
        let watcher = connection.signal_subscribe(
            Some("org.freedesktop.DBus"),
            Some("org.freedesktop.DBus"),
            Some("NameOwnerChanged"),
            Some("/org/freedesktop/DBus"),
            Some("org.kde.StatusNotifierWatcher"),
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, parameters| {
                if parameters
                    .get::<(String, String, String)>()
                    .is_some_and(|(_, _, owner)| owner.is_empty())
                {
                    let _ = events.send_event(crate::UserEvent::TrayUnavailable);
                }
            },
        );
        let host = connection.signal_subscribe(
            Some("org.kde.StatusNotifierWatcher"),
            Some("org.kde.StatusNotifierWatcher"),
            Some("StatusNotifierHostUnregistered"),
            Some("/StatusNotifierWatcher"),
            None,
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, _| {
                let _ = events_host.send_event(crate::UserEvent::TrayUnavailable);
            },
        );
        let tray = Tray {
            connection,
            registration: Some(registration),
            watcher: Some(watcher),
            host: Some(host),
        };
        // Passing our unique bus name lets the host watch this particular app's lifetime.
        let name = tray.connection.unique_name()?;
        tray.connection
            .call_sync(
                Some("org.kde.StatusNotifierWatcher"),
                "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
                "RegisterStatusNotifierItem",
                Some(&(name.as_str(),).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                gio::Cancellable::NONE,
            )
            .ok()?;
        Some(tray)
    }

    pub fn notify(title: &str, body: &str) -> Result<(), String> {
        send(title, body, false).map(|_| ())
    }

    /// Sends an alert that opens `path` on the saved server when clicked.
    pub fn notify_link(
        data: &Path,
        server: &str,
        path: &str,
        title: &str,
        body: &str,
    ) -> Result<(), String> {
        if !crate::link::valid_path(path) {
            return notify(title, body);
        }
        listen_for_clicks(data);
        // The lock is held across the send so a fast click waits for the entry to exist.
        let mut held = links().lock().unwrap_or_else(|e| e.into_inner());
        let id = send(title, body, true)?;
        held.insert(id, (server.to_owned(), path.to_owned()));
        Ok(())
    }

    type Links = std::sync::Mutex<HashMap<u32, (String, String)>>;

    /// Alerts on screen that carry a link, by the desktop's alert number.
    fn links() -> &'static Links {
        static LINKS: std::sync::OnceLock<Links> = std::sync::OnceLock::new();
        LINKS.get_or_init(Default::default)
    }

    /// Listens once per process for clicks. The desktop broadcasts every program's clicks, so
    /// only alert numbers this process sent count.
    fn listen_for_clicks(data: &Path) {
        static STARTED: std::sync::Once = std::sync::Once::new();
        let data = data.to_owned();
        STARTED.call_once(|| {
            let (ready, wait) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let context = gio::glib::MainContext::new();
                let _ = context.with_thread_default(|| {
                    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
                    else {
                        let _ = ready.send(());
                        return;
                    };
                    let subscribe = |signal: &str, action: Box<dyn Fn(&Variant) + 'static>| {
                        bus.signal_subscribe(
                            Some("org.freedesktop.Notifications"),
                            Some("org.freedesktop.Notifications"),
                            Some(signal),
                            Some("/org/freedesktop/Notifications"),
                            None,
                            gio::DBusSignalFlags::NONE,
                            move |_, _, _, _, _, params| action(params),
                        )
                    };
                    let _ = subscribe(
                        "ActionInvoked",
                        Box::new(move |params| {
                            let Some((id, key)) = params.get::<(u32, String)>() else {
                                return;
                            };
                            let link = links().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                            if let (Some((server, path)), "default") = (link, key.as_str()) {
                                let request = crate::link::Request {
                                    server: Some(server),
                                    path: Some(path),
                                };
                                if let Err(e) = crate::link::open(&data, &request) {
                                    eprintln!("moss-app notifier: {e}");
                                }
                            }
                        }),
                    );
                    let _ = subscribe(
                        "NotificationClosed",
                        Box::new(|params| {
                            if let Some((id, _)) = params.get::<(u32, u32)>() {
                                // A click also closes the alert; ActionInvoked arrives first.
                                links().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                            }
                        }),
                    );
                    let _ = ready.send(());
                    gio::glib::MainLoop::new(Some(&context), false).run();
                });
            });
            let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
        });
    }

    fn send(title: &str, body: &str, clickable: bool) -> Result<u32, String> {
        let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
            .map_err(|_| "Desktop notifications are unavailable")?;
        let hints: HashMap<String, Variant> = HashMap::new();
        let body = gio::glib::markup_escape_text(body);
        let actions: Vec<&str> = if clickable { vec!["default", "Open"] } else { Vec::new() };
        let reply = bus
            .call_sync(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "Notify",
                Some(
                    &(
                        "Moss",
                        0u32,
                        "applications-office",
                        title,
                        body.as_str(),
                        actions,
                        hints,
                        -1i32,
                    )
                        .to_variant(),
                ),
                None,
                gio::DBusCallFlags::NONE,
                1000,
                gio::Cancellable::NONE,
            )
            .map_err(|_| "Desktop notifications are unavailable")?;
        Ok(reply.get::<(u32,)>().map_or(0, |(id,)| id))
    }

    fn autostart_file(store: &Store) -> Result<PathBuf, String> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
            .ok_or("No settings folder")?;
        // A separate entry for each app data folder; portable installs do not overwrite one another.
        let id = store
            .data
            .to_string_lossy()
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
            });
        Ok(config.join(format!("autostart/moss-{id:016x}.desktop")))
    }

    pub fn starts_at_login(store: &Store) -> bool {
        autostart_file(store).is_ok_and(|p| p.is_file())
    }

    fn quoted(path: &Path) -> Result<String, String> {
        let text = path.to_str().ok_or("The install path is not valid text")?;
        if text.contains(['\n', '\r']) {
            return Err("The install path contains a line break".into());
        }
        Ok(format!(
            "\"{}\"",
            text.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('`', "\\`")
                .replace('$', "\\$")
                .replace('%', "%%")
        ))
    }

    pub fn set_login(store: &Store, install: &Path, enabled: bool) -> Result<(), String> {
        let path = autostart_file(store)?;
        if !enabled {
            return match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("Cannot turn off start at login".into()),
            };
        }
        std::fs::create_dir_all(path.parent().ok_or("No settings folder")?)
            .map_err(|_| "Cannot create login settings")?;
        let launch = login_command(install)?;
        let data = quoted(&store.data)?;
        let install = quoted(install)?;
        let entry = gio::glib::KeyFile::new();
        entry.set_string("Desktop Entry", "Type", "Application");
        entry.set_string("Desktop Entry", "Name", "Moss");
        entry.set_string(
            "Desktop Entry",
            "Exec",
            &format!("{launch} --data {data} --install {install}"),
        );
        entry.set_boolean("Desktop Entry", "Terminal", false);
        entry.set_boolean("Desktop Entry", "X-GNOME-Autostart-enabled", true);
        let entry = entry.to_data();
        private_write(&path, entry.as_bytes())
    }

    pub(super) fn login_command(install: &Path) -> Result<String, String> {
        if crate::launch::bundled_runtime(install) {
            let launcher = install.join("moss-run");
            if !launcher.is_file() {
                return Err("This copy of Moss is missing its runtime launcher".into());
            }
            Ok(format!("{} moss-app", quoted(&launcher)?))
        } else {
            quoted(&std::env::current_exe().map_err(|_| "Cannot find this app")?)
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(windows, target_os = "macos"))]
mod native {
    #[cfg(target_os = "macos")]
    use super::macos as os;
    #[cfg(windows)]
    use super::windows as os;
    use super::*;
    pub use os::{notify, Tray};
    /// Click-to-open is built for Linux; elsewhere the alert shows without a link.
    pub fn notify_link(
        _data: &std::path::Path,
        _server: &str,
        _path: &str,
        title: &str,
        body: &str,
    ) -> Result<(), String> {
        notify(title, body)
    }
    use std::path::Path;
    pub fn tray(proxy: tao::event_loop::EventLoopProxy<crate::UserEvent>) -> Option<Tray> {
        os::tray(move |action| {
            let _ = proxy.send_event(match action {
                identity::Action::Settings => crate::UserEvent::Desktop,
                identity::Action::Unavailable => crate::UserEvent::TrayUnavailable,
                identity::Action::Reveal => crate::UserEvent::Reveal,
            });
        })
    }
    pub fn starts_at_login(store: &Store) -> bool {
        os::starts_at_login(&store.data)
    }
    pub fn set_login(store: &Store, install: &Path, enabled: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            os::set_login(&store.data, install, enabled)
        }
        #[cfg(target_os = "macos")]
        {
            os::set_login(
                &store.data,
                install,
                enabled,
                moss_network::config::private_write,
            )
        }
    }
}
#[cfg(any(windows, target_os = "macos"))]
pub use native::*;

#[cfg(any(windows, target_os = "macos"))]
mod identity;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn staged_login_uses_launcher_with_desktop_escaping() {
        let root = std::env::temp_dir().join(format!("moss login $% {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        assert!(linux::login_command(&root).is_err());
        std::fs::write(root.join("moss-run"), "launcher").unwrap();
        let command = linux::login_command(&root).unwrap();
        assert!(command.ends_with("/moss-run\" moss-app"));
        assert!(command.contains("\\$%%"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notification_preferences_default_off_and_persist() {
        let root = std::env::temp_dir().join(format!("moss-desktop-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone());
        assert!(!Preferences::load(&store).unwrap().notifications);
        Preferences {
            notifications: true,
        }
        .save(&store)
        .unwrap();
        assert!(Preferences::load(&store).unwrap().notifications);
        std::fs::remove_dir_all(root).unwrap();
    }
}
