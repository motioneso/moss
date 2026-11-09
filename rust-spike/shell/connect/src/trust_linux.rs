//! Linux (WebKitGTK) certificate pinning for a server's web view.

use crate::pin::{host_of, pem};
use crate::{Opened, UserEvent};
use tao::event_loop::EventLoopProxy;
use wry::WebView;

/// Allows the pinned certificate for this server's host in its own profile, and reports failed
/// loads so the app can show why. WebKit also accepts certificates a public authority signed, so
/// every committed load is compared with the pin and closed when it differs. The request has
/// already been sent by then; WebKitGTK has no earlier hook. Only page loads are checked, so later
/// fetch and WebSocket connections from a loaded page are not.
pub fn install(
    view: &WebView,
    opened: &Opened,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<(), String> {
    use webkit2gtk::{WebContextExt, WebViewExt};
    use wry::WebViewExtUnix;
    let webkit = view.webview();
    let context = webkit.context().ok_or("No web context")?;
    let pem = pem(&opened.certificate);
    let certificate = gio::TlsCertificate::from_pem(&pem).map_err(|_| "Invalid certificate")?;
    let host = host_of(&opened.origin).ok_or("Invalid origin")?;
    context.allow_tls_certificate_for_host(&certificate, &host);
    let id = opened.id.clone();
    let failed = proxy.clone();
    webkit.connect_load_failed(move |_, _, _, _| {
        let _ = failed.send_event(UserEvent::Check(id.clone()));
        false
    });
    let id = opened.id.clone();
    let tls_failed = proxy.clone();
    webkit.connect_load_failed_with_tls_errors(move |_, _, _, _| {
        let _ = tls_failed.send_event(UserEvent::Check(id.clone()));
        false
    });
    let (id, pinned) = (opened.id.clone(), opened.certificate.clone());
    webkit.connect_load_changed(move |webkit, event| {
        use gio::prelude::TlsCertificateExt;
        if !matches!(event, webkit2gtk::LoadEvent::Committed) {
            return;
        }
        let presented = webkit
            .tls_info()
            .and_then(|(certificate, _)| certificate.certificate())
            .map(|der| der.to_vec());
        if presented.as_deref() != Some(pinned.as_slice()) {
            webkit.stop_loading();
            let fingerprint = presented.map(|der| moss_network::instance::fingerprint(&der));
            let _ = proxy.send_event(UserEvent::WrongCertificate(id.clone(), fingerprint));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn pem_round_trips_through_the_certificate_parser() {
        let der: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let pem = crate::pin::pem(&der);
        assert_eq!(
            moss_network::instance::leaf_der(pem.as_bytes()).unwrap(),
            der
        );
        for len in [1, 2, 3, 4, 65] {
            let short = &der[..len];
            assert_eq!(
                moss_network::instance::leaf_der(crate::pin::pem(short).as_bytes()).unwrap(),
                short
            );
        }
    }
}
