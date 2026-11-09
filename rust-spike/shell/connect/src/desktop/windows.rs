//! Win32 tray and session startup. All handles belong to this app, never another process.
use super::identity::{install_id, Action};
use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicIsize, Ordering};

type Handle = *mut c_void;
const CALLBACK: u32 = 0x8001;
static WINDOW: AtomicIsize = AtomicIsize::new(0);

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
unsafe extern "system" fn procedure(window: Handle, message: u32, w: usize, l: isize) -> isize {
    // SAFETY: forwarded to the system with exactly the callback arguments.
    unsafe { DefWindowProcW(window, message, w, l) }
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
            let mut item = icon(window);
            item.flags = 1 | 2 | 4; // message, icon, tooltip
            item.callback = CALLBACK;
            item.icon = LoadIconW(std::ptr::null_mut(), 32512usize as *const u16);
            fill(&mut item.tip, "Moss — right-click for Desktop settings");
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
            let restarted = RegisterWindowMessageW(wide("TaskbarCreated").as_ptr());
            let mut message: Message = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                if message.message == CALLBACK {
                    let event = match message.l as u32 {
                        0x0202 => Some(Action::Reveal),   // left release
                        0x0205 => Some(Action::Settings), // right release
                        _ => None,
                    };
                    if let Some(event) = event {
                        action(event);
                    }
                } else if message.message == 0x0010 {
                    break;
                } else if restarted != 0
                    && message.message == restarted
                    && Shell_NotifyIconW(0, &item) == 0
                {
                    // The icon is gone: the window must become reachable again.
                    action(Action::Unavailable);
                    break;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            action(Action::Unavailable);
            WINDOW.store(0, Ordering::SeqCst);
            Shell_NotifyIconW(2, &item);
            DestroyWindow(window);
        }
    });
    rx.recv().ok().flatten().map(|window| Tray { window })
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
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
