//! macOS (WKWebView) certificate pinning for a server's web view.
//!
//! wry's navigation delegate does not answer server-trust challenges, so the answering method is
//! added to its class once. Every TLS connection a server view makes then reaches `challenge`,
//! which compares the leaf certificate with the pin registered for that host and port. The match
//! is trusted, a mismatch on the server's own address is cancelled and reported, and any other
//! host gets the system's default handling (the navigation handler already blocks other origins).
//! A challenge arrives before any request is sent, so unlike Linux nothing reaches a wrong server.

use crate::pin::host_of;
use crate::{Opened, UserEvent};
use block2::Block;
use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, Once};
use tao::event_loop::EventLoopProxy;
use wry::WebView;

const USE_CREDENTIAL: isize = 0;
const DEFAULT_HANDLING: isize = 1;
const CANCEL: isize = 2;

struct Pin {
    id: String,
    certificate: Vec<u8>,
    proxy: EventLoopProxy<UserEvent>,
}

/// Keyed by "host:port". Server views of other instances on the same host have other ports.
static PINS: Mutex<Option<HashMap<String, Pin>>> = Mutex::new(None);
static INSTALL: Once = Once::new();

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTrustGetCertificateAtIndex(trust: *mut c_void, index: isize) -> *mut c_void;
    fn SecCertificateCopyData(certificate: *mut c_void) -> *mut c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataGetBytePtr(data: *mut c_void) -> *const u8;
    fn CFDataGetLength(data: *mut c_void) -> isize;
    fn CFRelease(object: *mut c_void);
}

pub fn install(
    _view: &WebView,
    opened: &Opened,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<(), String> {
    let host = host_of(&opened.origin).ok_or("Invalid origin")?;
    let port = url::Url::parse(&opened.origin)
        .ok()
        .and_then(|u| u.port_or_known_default())
        .ok_or("Invalid origin")?;
    let mut ok = true;
    INSTALL.call_once(|| ok = add_method());
    if !ok {
        return Err("Could not watch certificates".into());
    }
    PINS.lock()
        .map_err(|_| "Could not watch certificates")?
        .get_or_insert_with(HashMap::new)
        .insert(
            format!("{host}:{port}"),
            Pin {
                id: opened.id.clone(),
                certificate: opened.certificate.clone(),
                proxy,
            },
        );
    Ok(())
}

/// Adds the challenge method to wry's delegate class. It is absent there, so nothing is replaced.
fn add_method() -> bool {
    let Some(class) = AnyClass::get(c"WryNavigationDelegate") else {
        return false;
    };
    let selector = sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
    if class.instance_method(selector).is_some() {
        return false;
    }
    let imp: unsafe extern "C-unwind" fn() = unsafe {
        std::mem::transmute(
            challenge
                as unsafe extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                    *mut AnyObject,
                    *mut Block<dyn Fn(isize, *mut AnyObject)>,
                ),
        )
    };
    // SAFETY: the class is registered and the type string matches `challenge`.
    unsafe {
        ffi::class_addMethod(
            class as *const AnyClass as *mut _,
            selector,
            imp,
            c"v@:@@@?".as_ptr(),
        )
        .as_bool()
    }
}

unsafe extern "C-unwind" fn challenge(
    _this: *mut AnyObject,
    _selector: Sel,
    _web_view: *mut AnyObject,
    challenge: *mut AnyObject,
    completion: *mut Block<dyn Fn(isize, *mut AnyObject)>,
) {
    let answer = |disposition: isize, credential: *mut AnyObject| {
        // SAFETY: the system passes a live completion block.
        unsafe { (*completion).call((disposition, credential)) }
    };
    // SAFETY: `challenge` is a live NSURLAuthenticationChallenge for this call.
    unsafe {
        let space: *mut AnyObject = msg_send![challenge, protectionSpace];
        let method: *mut NSString = msg_send![space, authenticationMethod];
        if space.is_null()
            || method.is_null()
            || (*method).to_string() != "NSURLAuthenticationMethodServerTrust"
        {
            return answer(DEFAULT_HANDLING, std::ptr::null_mut());
        }
        let host: *mut NSString = msg_send![space, host];
        let port: isize = msg_send![space, port];
        let trust: *mut c_void = msg_send![space, serverTrust];
        if host.is_null() || trust.is_null() {
            return answer(DEFAULT_HANDLING, std::ptr::null_mut());
        }
        let key = format!("{}:{port}", (*host).to_string());
        let guard = PINS.lock().ok();
        let Some(pin) = guard.as_ref().and_then(|g| g.as_ref()?.get(&key)) else {
            return answer(DEFAULT_HANDLING, std::ptr::null_mut());
        };
        let presented = leaf(trust);
        if presented.as_deref() == Some(pin.certificate.as_slice()) {
            let class = AnyClass::get(c"NSURLCredential");
            let credential: *mut AnyObject = match class {
                Some(class) => msg_send![class, credentialForTrust: trust],
                None => std::ptr::null_mut(),
            };
            if credential.is_null() {
                return answer(CANCEL, std::ptr::null_mut());
            }
            return answer(USE_CREDENTIAL, credential);
        }
        let fingerprint = presented.map(|der| moss_network::instance::fingerprint(&der));
        let _ = pin
            .proxy
            .send_event(UserEvent::WrongCertificate(pin.id.clone(), fingerprint));
        answer(CANCEL, std::ptr::null_mut());
    }
}

/// The server's own (leaf) certificate, as DER.
///
/// # Safety
/// `trust` must be a live SecTrustRef.
unsafe fn leaf(trust: *mut c_void) -> Option<Vec<u8>> {
    unsafe {
        let certificate = SecTrustGetCertificateAtIndex(trust, 0);
        if certificate.is_null() {
            return None;
        }
        let data = SecCertificateCopyData(certificate);
        if data.is_null() {
            return None;
        }
        let bytes =
            std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize)
                .to_vec();
        CFRelease(data);
        Some(bytes)
    }
}
