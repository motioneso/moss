//! AppKit status item and notifications; launchd starts this particular app data folder.
use super::identity::{install_id, Action};
use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

static EVENTS: Mutex<Option<Box<dyn Fn(Action) + Send>>> = Mutex::new(None);
static REGISTER: Once = Once::new();

unsafe extern "C-unwind" fn activate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {
    if let Ok(events) = EVENTS.lock() {
        if let Some(events) = events.as_ref() {
            events(Action::Reveal);
        }
    }
}
unsafe extern "C-unwind" fn settings(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {
    if let Ok(events) = EVENTS.lock() {
        if let Some(events) = events.as_ref() {
            events(Action::Settings);
        }
    }
}

pub struct Tray {
    item: *mut AnyObject,
    target: *mut AnyObject,
    menu: *mut AnyObject,
}
impl Drop for Tray {
    fn drop(&mut self) {
        // SAFETY: these objects were retained on the main event thread by tray().
        unsafe {
            let bar: *mut AnyObject =
                msg_send![AnyClass::get(c"NSStatusBar").unwrap(), systemStatusBar];
            let _: () = msg_send![bar, removeStatusItem: self.item];
            let _: () = msg_send![self.item, release];
            let _: () = msg_send![self.menu, release];
            let _: () = msg_send![self.target, release];
        }
        if let Ok(mut events) = EVENTS.lock() {
            *events = None;
        }
    }
}

pub fn tray(action: impl Fn(Action) + Send + 'static) -> Option<Tray> {
    // SAFETY: called on tao's main thread after creating the NSApplication. Registered
    // selectors have the exact Objective-C v@:@ signature; targets outlive their menus.
    unsafe {
        REGISTER.call_once(|| {
            let base = AnyClass::get(c"NSObject").unwrap();
            let class = ffi::objc_allocateClassPair(
                base as *const AnyClass,
                c"MossDesktopActions".as_ptr(),
                0,
            );
            if !class.is_null() {
                for (selector, callback) in [
                    (
                        sel!(reveal:),
                        activate
                            as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                    ),
                    (sel!(settings:), settings),
                ] {
                    let implementation = std::mem::transmute::<
                        unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                        unsafe extern "C-unwind" fn(),
                    >(callback);
                    ffi::class_addMethod(class, selector, implementation, c"v@:@".as_ptr());
                }
                ffi::objc_registerClassPair(class);
            }
        });
        let actions = AnyClass::get(c"MossDesktopActions")?;
        let target: *mut AnyObject = msg_send![actions, new];
        let bar: *mut AnyObject = msg_send![AnyClass::get(c"NSStatusBar")?, systemStatusBar];
        let item: *mut AnyObject = msg_send![bar, statusItemWithLength: -1.0f64];
        if item.is_null() {
            let _: () = msg_send![target, release];
            return None;
        }
        let _: *mut AnyObject = msg_send![item, retain];
        let button: *mut AnyObject = msg_send![item, button];
        let _: () = msg_send![button, setTitle: &*NSString::from_str("M")];
        let _: () = msg_send![button, setToolTip: &*NSString::from_str("Moss")];
        let menu: *mut AnyObject = msg_send![AnyClass::get(c"NSMenu")?, new];
        for (title, action) in [
            ("Open Moss", sel!(reveal:)),
            ("Desktop settings", sel!(settings:)),
        ] {
            let entry: *mut AnyObject = msg_send![menu, addItemWithTitle: &*NSString::from_str(title), action: action, keyEquivalent: &*NSString::from_str("")];
            let _: () = msg_send![entry, setTarget: target];
        }
        let _: () = msg_send![item, setMenu: menu];
        *EVENTS.lock().ok()? = Some(Box::new(action));
        Some(Tray { item, target, menu })
    }
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    // NSUserNotification remains available on supported macOS releases. A signed app bundle
    // and the user's OS permission are required for delivery; Phase 7 qualifies those.
    unsafe {
        let class = AnyClass::get(c"NSUserNotificationCenter")
            .ok_or("macOS notifications are unavailable")?;
        let center: *mut AnyObject = msg_send![class, defaultUserNotificationCenter];
        if center.is_null() {
            return Err("macOS notifications need an installed Moss app bundle".into());
        }
        let notification: *mut AnyObject = msg_send![
            AnyClass::get(c"NSUserNotification").ok_or("macOS notifications are unavailable")?,
            new
        ];
        let _: () = msg_send![notification, setTitle: &*NSString::from_str(title)];
        let _: () = msg_send![notification, setInformativeText: &*NSString::from_str(body)];
        let _: () = msg_send![center, deliverNotification: notification];
        let _: () = msg_send![notification, release];
    }
    Ok(())
}

fn login_file(data: &Path) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("No home folder")?;
    Ok(PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("app.moss.desktop.{:016x}.plist", install_id(data))))
}
pub fn starts_at_login(data: &Path) -> bool {
    login_file(data).is_ok_and(|p| p.is_file())
}
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub fn set_login(
    data: &Path,
    install: &Path,
    enabled: bool,
    write: impl Fn(&Path, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let path = login_file(data)?;
    if !enabled {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Cannot turn off start at login".into()),
        };
    }
    let exe = std::env::current_exe().map_err(|_| "Cannot find this app")?;
    let paths = [&exe, data, install];
    let args = paths
        .iter()
        .map(|p| {
            p.to_str()
                .filter(|s| !s.chars().any(|c| c.is_control()))
                .map(xml)
                .ok_or("The install path is not valid text")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let label = format!("app.moss.desktop.{:016x}", install_id(data));
    let plist = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{}</string><string>--data</string><string>{}</string><string>--install</string><string>{}</string></array><key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>", args[0], args[1], args[2]);
    std::fs::create_dir_all(path.parent().ok_or("No login settings folder")?)
        .map_err(|_| "Cannot create login settings")?;
    write(&path, plist.as_bytes())
}
