//! Win32 tray and session startup. All handles belong to this app, never another process.
use super::identity::{install_id, Action};
use std::cell::RefCell;
use std::ffi::c_void;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;

type Handle = *mut c_void;
const CALLBACK: u32 = 0x8001;
static WINDOW: AtomicIsize = AtomicIsize::new(0);
/// The notifier keeps its icon hidden. Hidden icons still show balloons.
static HIDDEN: AtomicBool = AtomicBool::new(false);
/// Sent to the icon's window when the user clicks a balloon.
const BALLOON_USER_CLICK: u32 = 0x405;
/// The page link of the balloon on screen, if it has one: data folder, server and path.
static PENDING: Mutex<Option<(PathBuf, String, String)>> = Mutex::new(None);

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct Message {
    window: Handle,
    message: u32,
    w: usize,
    l: isize,
    time: u32,
    point: Point,
    private: u32,
}
#[repr(C)]
struct WindowClass {
    size: u32,
    style: u32,
    procedure: Option<unsafe extern "system" fn(Handle, u32, usize, isize) -> isize>,
    class_extra: i32,
    window_extra: i32,
    instance: Handle,
    icon: Handle,
    cursor: Handle,
    background: Handle,
    menu: *const u16,
    name: *const u16,
    small_icon: Handle,
}
#[repr(C)]
struct Icon {
    size: u32,
    window: Handle,
    id: u32,
    flags: u32,
    callback: u32,
    icon: Handle,
    tip: [u16; 128],
    state: u32,
    state_mask: u32,
    info: [u16; 256],
    version: u32,
    title: [u16; 64],
    info_flags: u32,
    guid: [u8; 16],
    balloon: Handle,
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassExW(class: *const WindowClass) -> u16;
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Handle,
        menu: Handle,
        instance: Handle,
        parameter: Handle,
    ) -> Handle;
    fn DefWindowProcW(window: Handle, message: u32, w: usize, l: isize) -> isize;
    fn DestroyWindow(window: Handle) -> i32;
    fn LoadIconW(instance: Handle, name: *const u16) -> Handle;
    fn GetMessageW(message: *mut Message, window: Handle, first: u32, last: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
    fn PostMessageW(window: Handle, message: u32, w: usize, l: isize) -> i32;
    fn PostQuitMessage(exit_code: i32);
    fn RegisterWindowMessageW(name: *const u16) -> u32;
}
#[link(name = "shell32")]
extern "system" {
    fn Shell_NotifyIconW(message: u32, icon: *const Icon) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
}
#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        key: Handle,
        subkey: *const u16,
        reserved: u32,
        class: *mut u16,
        options: u32,
        access: u32,
        security: Handle,
        result: *mut Handle,
        disposition: *mut u32,
    ) -> i32;
    fn RegOpenKeyExW(
        key: Handle,
        subkey: *const u16,
        options: u32,
        access: u32,
        result: *mut Handle,
    ) -> i32;
    fn RegSetValueExW(
        key: Handle,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        size: u32,
    ) -> i32;
    fn RegQueryValueExW(
        key: Handle,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        size: *mut u32,
    ) -> i32;
    fn RegDeleteValueW(key: Handle, name: *const u16) -> i32;
    fn RegCloseKey(key: Handle) -> i32;
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn fill<const N: usize>(out: &mut [u16; N], text: &str) {
    for (slot, value) in out.iter_mut().take(N - 1).zip(text.encode_utf16()) {
        *slot = value;
    }
}
fn icon(window: Handle) -> Icon {
    // SAFETY: the structure contains only integer fields and nullable pointers.
    let mut icon: Icon = unsafe { std::mem::zeroed() };
    icon.size = std::mem::size_of::<Icon>() as u32;
    icon.window = window;
    icon.id = 1;
    icon
}
struct Callbacks {
    action: Box<dyn Fn(Action)>,
    restarted: u32,
}
thread_local! {
    // Accessed only by the thread that owns the hidden tray window.
    static CALLBACKS: RefCell<Option<Callbacks>> = const { RefCell::new(None) };
}
fn tray_icon(window: Handle) -> Icon {
    let mut item = icon(window);
    item.flags = 1 | 2 | 4; // message, icon, tooltip
    item.callback = CALLBACK;
    if HIDDEN.load(Ordering::SeqCst) {
        item.flags |= 8; // NIF_STATE
        item.state = 1; // NIS_HIDDEN
        item.state_mask = 1;
    }
    // SAFETY: IDI_APPLICATION is a predefined system resource.
    item.icon = unsafe { LoadIconW(std::ptr::null_mut(), 32512usize as *const u16) };
    fill(&mut item.tip, "Moss — right-click for Desktop settings");
    item
}
unsafe extern "system" fn procedure(window: Handle, message: u32, w: usize, l: isize) -> isize {
    // Sent messages arrive here while GetMessageW is waiting; posted messages arrive
    // through DispatchMessageW. Handle both in the window procedure.
    let handled = CALLBACKS.with(|cell| {
        let callbacks = cell.borrow();
        let Some(callbacks) = callbacks.as_ref() else {
            return false;
        };
        if message == CALLBACK {
            if l as u32 == BALLOON_USER_CLICK {
                open_pending();
            }
            let event = match l as u32 {
                0x0202 => Some(Action::Reveal),
                0x0205 => Some(Action::Settings),
                _ => None,
            };
            if let Some(event) = event {
                (callbacks.action)(event);
            }
            true
        } else if message == 0x0010 {
            unsafe {
                PostQuitMessage(0);
            }
            true
        } else if callbacks.restarted != 0 && message == callbacks.restarted {
            if unsafe { Shell_NotifyIconW(0, &tray_icon(window)) } == 0 {
                (callbacks.action)(Action::Unavailable);
                unsafe {
                    PostQuitMessage(0);
                }
            }
            true
        } else {
            false
        }
    });
    if handled {
        0
    } else {
        // SAFETY: forwarded to the system with exactly the callback arguments.
        unsafe { DefWindowProcW(window, message, w, l) }
    }
}

pub struct Tray {
    window: isize,
}
impl Drop for Tray {
    fn drop(&mut self) {
        WINDOW.store(0, Ordering::SeqCst);
        // SAFETY: posting asks the owning thread to delete its own icon and window.
        unsafe {
            PostMessageW(self.window as Handle, 0x0010, 0, 0);
        }
    }
}
pub fn tray(action: impl Fn(Action) + Send + 'static) -> Option<Tray> {
    start(action)
}

/// The notifier's window for balloons: an icon nobody sees, so clicks reach `procedure`.
pub fn hidden_tray() -> Option<Tray> {
    HIDDEN.store(true, Ordering::SeqCst);
    start(|_| {})
}

fn start(action: impl Fn(Action) + Send + 'static) -> Option<Tray> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        // SAFETY: this thread owns the window, class registration and message loop. All
        // buffers remain live for their calls; Shell_NotifyIcon copies its structure.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let name = wide("MossTrayWindow");
            let mut class: WindowClass = std::mem::zeroed();
            class.size = std::mem::size_of::<WindowClass>() as u32;
            class.procedure = Some(procedure);
            class.instance = instance;
            class.name = name.as_ptr();
            RegisterClassExW(&class);
            let window = CreateWindowExW(
                0,
                name.as_ptr(),
                name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null_mut(),
            );
            if window.is_null() {
                let _ = tx.send(None);
                return;
            }
            let item = tray_icon(window);
            CALLBACKS.with(|cell| {
                *cell.borrow_mut() = Some(Callbacks {
                    action: Box::new(action),
                    restarted: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
                })
            });
            if Shell_NotifyIconW(0, &item) == 0 {
                DestroyWindow(window);
                let _ = tx.send(None);
                return;
            }
            WINDOW.store(window as isize, Ordering::SeqCst);
            if tx.send(Some(window as isize)).is_err() {
                Shell_NotifyIconW(2, &item);
                DestroyWindow(window);
                return;
            }
            let mut message: Message = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            CALLBACKS.with(|cell| {
                if let Some(callbacks) = cell.borrow_mut().take() {
                    (callbacks.action)(Action::Unavailable);
                }
            });
            WINDOW.store(0, Ordering::SeqCst);
            Shell_NotifyIconW(2, &item);
            DestroyWindow(window);
        }
    });
    rx.recv().ok().flatten().map(|window| Tray { window })
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    show_and_remember(title, body, None)
}

/// Shows an alert that opens `path` on the saved server when the user clicks it.
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
    show_and_remember(
        title,
        body,
        Some((data.to_owned(), server.to_owned(), path.to_owned())),
    )
}

/// Waits between notifier rounds. The icon's own thread handles clicks meanwhile.
pub fn pause(duration: std::time::Duration) {
    std::thread::sleep(duration);
}

/// Only one balloon is on screen, so one remembered link is enough. A newer balloon replaces it.
/// The lock is held across the show, so a click always sees the link of the balloon it hit.
/// A failed show leaves the previous balloon and its link untouched.
fn show_and_remember(
    title: &str,
    body: &str,
    link: Option<(PathBuf, String, String)>,
) -> Result<(), String> {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    show(title, body)?;
    *pending = link;
    Ok(())
}

#[cfg(test)]
fn remember(link: Option<(PathBuf, String, String)>) {
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = link;
}

/// Takes the click for the balloon on screen and hands it to the window app.
fn open_pending() {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((data, server, path)) = pending {
        let request = crate::link::Request {
            server: Some(server),
            path: Some(path),
        };
        if let Err(e) = crate::link::open(&data, &request) {
            eprintln!("moss-app notifier: {e}");
        }
    }
}

fn show(title: &str, body: &str) -> Result<(), String> {
    let window = WINDOW.load(Ordering::SeqCst);
    if window == 0 {
        return Err("The Windows notification icon is unavailable".into());
    }
    let mut item = icon(window as Handle);
    item.flags = 0x10; // NIF_INFO
    item.info_flags = 1; // NIIF_INFO; OS notification settings still apply
    fill(&mut item.title, title);
    fill(&mut item.info, body);
    // SAFETY: initialized fixed-size native structure; the API copies it synchronously.
    if unsafe { Shell_NotifyIconW(1, &item) } == 0 {
        Err("Windows could not show the notification".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("moss balloon {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn click(window: isize) {
        // SAFETY: posting a message to this process's own window.
        unsafe { PostMessageW(window as Handle, CALLBACK, 0, BALLOON_USER_CLICK as isize) };
    }

    /// The window procedure receives the message Windows sends for a balloon click. The test
    /// posts that message itself: a real mouse click needs a person at the screen.
    #[test]
    fn balloon_click_opens_the_page_the_alert_carries() {
        let dir = folder();
        // Holding the window lock stops the click from starting a second app.
        let _window = crate::link::window_lock(&dir).expect("window lock");
        let tray = hidden_tray().expect("the notification window starts");
        let window = WINDOW.load(Ordering::SeqCst);
        remember(Some((dir.clone(), "s1".into(), "/tasks".into())));
        click(window);
        let mut taken = None;
        for _ in 0..50 {
            taken = crate::link::take_request(&dir);
            if taken.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let want = crate::link::Request {
            server: Some("s1".into()),
            path: Some("/tasks".into()),
        };
        assert_eq!(taken, Some(want));
        // The click is used up: a second click on the same balloon opens nothing.
        click(window);
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert_eq!(crate::link::take_request(&dir), None);
        // A plain alert replaces the link, so its click opens nothing either.
        remember(Some((dir.clone(), "s1".into(), "/notes".into())));
        let _ = notify("plain", "no link");
        click(window);
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert_eq!(crate::link::take_request(&dir), None);
        drop(tray);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
fn value_name(data: &Path) -> Vec<u16> {
    wide(&format!("Moss-{:016x}", install_id(data)))
}
struct Key(Handle);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn current_user() -> Handle {
    (-2147483647isize) as Handle
}
pub fn starts_at_login(data: &Path) -> bool {
    let mut key = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(current_user(), wide(RUN).as_ptr(), 0, 1, &mut key) != 0 {
            return false;
        }
        let key = Key(key);
        RegQueryValueExW(
            key.0,
            value_name(data).as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut 0,
        ) == 0
    }
}
pub fn set_login(data: &Path, install: &Path, enabled: bool) -> Result<(), String> {
    let mut key = std::ptr::null_mut();
    // SAFETY: registry buffers are terminated UTF-16 and handles are closed by Key.
    unsafe {
        if RegCreateKeyExW(
            current_user(),
            wide(RUN).as_ptr(),
            0,
            std::ptr::null_mut(),
            0,
            2,
            std::ptr::null_mut(),
            &mut key,
            std::ptr::null_mut(),
        ) != 0
        {
            return Err("Cannot open Windows login settings".into());
        }
        let key = Key(key);
        let name = value_name(data);
        let result = if enabled {
            let exe = std::env::current_exe().map_err(|_| "Cannot find this app")?;
            let quote = |path: &Path| -> Result<String, String> {
                let text = path.to_str().ok_or("The install path is not valid text")?;
                if text.contains(['"', '\r', '\n', '\0']) || text.ends_with('\\') {
                    return Err("The install path cannot be saved in login settings".into());
                }
                Ok(format!("\"{text}\""))
            };
            let command = wide(&format!(
                "{} --data {} --install {}",
                quote(&exe)?,
                quote(data)?,
                quote(install)?
            ));
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                1,
                command.as_ptr().cast(),
                (command.len() * 2) as u32,
            )
        } else {
            RegDeleteValueW(key.0, name.as_ptr())
        };
        if result == 0 || (!enabled && result == 2) {
            Ok(())
        } else {
            Err("Cannot change Windows start at login".into())
        }
    }
}
