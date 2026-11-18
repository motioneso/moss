//! Windows (WebView2) certificate pinning for a server's web view.
//!
//! WebView2 raises a server-certificate-error event only when the system does not already trust
//! the certificate. The handler allows the pinned certificate and cancels everything else, so a
//! different self-signed certificate on the same host still fails. A public authority's
//! certificate raises no event and loads normally, which is the same gap Linux has. Every open
//! and retry runs the native hello against the pin first.

use crate::pin::der_from_pem;
use crate::{Opened, UserEvent};
use tao::event_loop::EventLoopProxy;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_14, COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
    COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
};
use webview2_com::{
    take_pwstr, NavigationCompletedEventHandler, ServerCertificateErrorDetectedEventHandler,
};
use windows_core::{Interface, BOOL, PWSTR};
use wry::{WebView, WebViewExtWindows};

pub fn install(
    view: &WebView,
    opened: &Opened,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<(), String> {
    let core = view.webview();
    let core14: ICoreWebView2_14 = core
        .cast()
        .map_err(|_| "This version of WebView2 cannot pin certificates")?;
    let (id, pinned, origin) = (
        opened.id.clone(),
        opened.certificate.clone(),
        opened.origin.clone(),
    );
    let wrong = proxy.clone();
    let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        // SAFETY: the arguments are valid for the duration of the callback.
        unsafe {
            let mut uri = PWSTR::null();
            args.RequestUri(&mut uri)?;
            let uri = take_pwstr(uri);
            let mut pem = PWSTR::null();
            args.ServerCertificate()?.ToPemEncoding(&mut pem)?;
            let presented = der_from_pem(&take_pwstr(pem));
            if presented.as_deref() == Some(pinned.as_slice()) && is_ours(&uri, &origin) {
                args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?;
                return Ok(());
            }
            args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
            if is_ours(&uri, &origin) {
                let fingerprint = presented.map(|der| moss_network::instance::fingerprint(&der));
                let _ = wrong.send_event(UserEvent::WrongCertificate(id.clone(), fingerprint));
            }
        }
        Ok(())
    }));
    let failed_id = opened.id.clone();
    let failed = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut ok = BOOL(1);
            // SAFETY: `ok` outlives the call.
            if unsafe { args.IsSuccess(&mut ok) }.is_ok() && !ok.as_bool() {
                let _ = proxy.send_event(UserEvent::Check(failed_id.clone()));
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: both handlers live as long as the web view.
    unsafe {
        core14
            .add_ServerCertificateErrorDetected(&handler, &mut token)
            .map_err(|_| "Could not watch certificates")?;
        core.add_NavigationCompleted(&failed, &mut token)
            .map_err(|_| "Could not watch page loads")?;
    }
    Ok(())
}

fn is_ours(uri: &str, origin: &str) -> bool {
    uri == origin || uri.starts_with(&format!("{origin}/"))
}
