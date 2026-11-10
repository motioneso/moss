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
static DELEGATE: Once = Once::new();
/// The data folder that clicked alerts hand their page request to.
static CLICK_DATA: Mutex<Option<PathBuf>> = Mutex::new(None);
const SERVER_KEY: &str = "moss-server";
const PATH_KEY: &str = "moss-path";

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
    deliver(title, body, None)
}

/// Shows an alert that opens `path` on the saved server when the user clicks it. The click
/// arrives in this process, so the notifier must be the process that showed the alert.
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
    *CLICK_DATA.lock().unwrap_or_else(|e| e.into_inner()) = Some(data.to_owned());
    deliver(title, body, Some((server, path)))
}

/// Turns a clicked alert's stored server and page into the request the window app reads.
fn route_click(data: &Path, server: Option<String>, path: Option<String>) {
    let (Some(server), Some(path)) = (server, path) else {
        return;
    };
    let request = crate::link::Request {
        server: Some(server),
        path: Some(path),
    };
    if let Err(e) = crate::link::open(data, &request) {
        eprintln!("moss-app notifier: {e}");
    }
}

unsafe fn string_value(dictionary: *mut AnyObject, key: &str) -> Option<String> {
    let value: *mut AnyObject = msg_send![dictionary, objectForKey: &*NSString::from_str(key)];
    if value.is_null() {
        return None;
    }
    let bytes: *const std::ffi::c_char = msg_send![value, UTF8String];
    if bytes.is_null() {
        return None;
    }
    Some(
        std::ffi::CStr::from_ptr(bytes)
            .to_string_lossy()
            .into_owned(),
    )
}

unsafe extern "C-unwind" fn did_activate(
    _: *mut AnyObject,
    _: Sel,
    _center: *mut AnyObject,
    notification: *mut AnyObject,
) {
    let info: *mut AnyObject = msg_send![notification, userInfo];
    if info.is_null() {
        return;
    }
    let data = CLICK_DATA.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(data) = data {
        route_click(
            &data,
            string_value(info, SERVER_KEY),
            string_value(info, PATH_KEY),
        );
    }
}

/// Alerts show even while the app is frontmost.
unsafe extern "C-unwind" fn should_present(
    _: *mut AnyObject,
    _: Sel,
    _center: *mut AnyObject,
    _notification: *mut AnyObject,
) -> i8 {
    1
}

/// Registers the delegate class once and returns a new instance that is never released: the
/// notification center keeps only a weak reference to its delegate.
unsafe fn delegate() -> Option<*mut AnyObject> {
    DELEGATE.call_once(|| {
        let base = AnyClass::get(c"NSObject").unwrap();
        let class = ffi::objc_allocateClassPair(
            base as *const AnyClass,
            c"MossNotificationDelegate".as_ptr(),
            0,
        );
        if class.is_null() {
            return;
        }
        let activate = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject),
            unsafe extern "C-unwind" fn(),
        >(did_activate);
        let present = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) -> i8,
            unsafe extern "C-unwind" fn(),
        >(should_present);
        ffi::class_addMethod(
            class,
            sel!(userNotificationCenter:didActivateNotification:),
            activate,
            c"v@:@@".as_ptr(),
        );
        ffi::class_addMethod(
            class,
            sel!(userNotificationCenter:shouldPresentNotification:),
            present,
            c"c@:@@".as_ptr(),
        );
        ffi::objc_registerClassPair(class);
    });
    let class = AnyClass::get(c"MossNotificationDelegate")?;
    let instance: *mut AnyObject = msg_send![class, new];
    (!instance.is_null()).then_some(instance)
}

/// Makes this process the notification center's delegate, so clicks on its alerts reach it.
pub fn listen_for_clicks(data: &Path) {
    *CLICK_DATA.lock().unwrap_or_else(|e| e.into_inner()) = Some(data.to_owned());
    // SAFETY: the center and delegate are Objective-C objects used on the calling thread.
    unsafe {
        let Some(class) = AnyClass::get(c"NSUserNotificationCenter") else {
            return;
        };
        let center: *mut AnyObject = msg_send![class, defaultUserNotificationCenter];
        if center.is_null() {
            return;
        }
        if let Some(delegate) = delegate() {
            let _: () = msg_send![center, setDelegate: delegate];
        }
    }
}

/// Lets the main run loop deliver clicks while the notifier waits for its next round.
pub fn pause(duration: std::time::Duration) {
    // SAFETY: Foundation classes, called on the thread that owns this run loop.
    unsafe {
        let (Some(date), Some(run_loop)) = (AnyClass::get(c"NSDate"), AnyClass::get(c"NSRunLoop"))
        else {
            return std::thread::sleep(duration);
        };
        let until: *mut AnyObject =
            msg_send![date, dateWithTimeIntervalSinceNow: duration.as_secs_f64()];
        let current: *mut AnyObject = msg_send![run_loop, currentRunLoop];
        let _: () = msg_send![current, runUntilDate: until];
    }
}

fn deliver(title: &str, body: &str, link: Option<(&str, &str)>) -> Result<(), String> {
    // This legacy native API is guarded by class availability. Delivery on supported macOS
    // releases, bundle identity and OS permission still need Phase 7 runtime qualification.
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
        if let Some((server, path)) = link {
            let info: *mut AnyObject = msg_send![
                AnyClass::get(c"NSMutableDictionary")
                    .ok_or("macOS notifications are unavailable")?,
                new
            ];
            for (key, value) in [(SERVER_KEY, server), (PATH_KEY, path)] {
                let _: () = msg_send![info, setObject: &*NSString::from_str(value), forKey: &*NSString::from_str(key)];
            }
            let _: () = msg_send![notification, setUserInfo: info];
            let _: () = msg_send![info, release];
        }
        let _: () = msg_send![center, deliverNotification: notification];
        let _: () = msg_send![notification, release];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("moss click {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Builds a notification the way `deliver` does, then calls the delegate method the
    /// notification center calls on a click. A real click needs a person at the screen.
    #[test]
    fn click_on_an_alert_asks_the_window_app_for_its_page() {
        let dir = folder();
        let _window = crate::link::window_lock(&dir).expect("window lock");
        *CLICK_DATA.lock().unwrap() = Some(dir.clone());
        unsafe {
            let delegate = delegate().expect("delegate class");
            let notification: *mut AnyObject =
                msg_send![AnyClass::get(c"NSUserNotification").unwrap(), new];
            let info: *mut AnyObject =
                msg_send![AnyClass::get(c"NSMutableDictionary").unwrap(), new];
            for (key, value) in [(SERVER_KEY, "s1"), (PATH_KEY, "/tasks")] {
                let _: () = msg_send![info, setObject: &*NSString::from_str(value), forKey: &*NSString::from_str(key)];
            }
            let _: () = msg_send![notification, setUserInfo: info];
            let center: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![delegate, userNotificationCenter: center, didActivateNotification: notification];
            // An alert with no link stores no page, so its click opens nothing.
            let plain: *mut AnyObject =
                msg_send![AnyClass::get(c"NSUserNotification").unwrap(), new];
            let _: () =
                msg_send![delegate, userNotificationCenter: center, didActivateNotification: plain];
        }
        let want = crate::link::Request {
            server: Some("s1".into()),
            path: Some("/tasks".into()),
        };
        assert_eq!(crate::link::take_request(&dir), Some(want));
        assert_eq!(crate::link::take_request(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_click_without_a_server_or_page_is_ignored() {
        let dir = folder();
        route_click(&dir, None, Some("/tasks".into()));
        route_click(&dir, Some("s1".into()), None);
        assert_eq!(crate::link::take_request(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
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
