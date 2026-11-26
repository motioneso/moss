//! The standard DBusMenu surface used by StatusNotifier tray hosts.
use gio::glib::{variant::ToVariant, Variant};
use std::collections::HashMap;
const XML: &str = r#"<node><interface name="com.canonical.dbusmenu">
<method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/><arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method>
<method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
<method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/><property name="Status" type="s" access="read"/>
<signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
</interface></node>"#;
fn entries() -> Vec<(i32, HashMap<String, Variant>)> {
    let status = super::server_status();
    let label = status
        .as_ref()
        .map(|s| s.1.as_str())
        .unwrap_or("No local server");
    [
        (1, "Open Moss", true),
        (2, label, false),
        (3, "Stop server", status.is_some_and(|s| s.2)),
        (4, "Desktop settings", true),
        (5, "Quit app", true),
    ]
    .into_iter()
    .map(|(id, label, enabled)| {
        (
            id,
            HashMap::from([
                ("label".into(), label.to_variant()),
                ("enabled".into(), enabled.to_variant()),
                ("visible".into(), true.to_variant()),
            ]),
        )
    })
    .collect()
}
pub fn register(
    connection: &gio::DBusConnection,
    proxy: tao::event_loop::EventLoopProxy<crate::UserEvent>,
) -> Option<gio::RegistrationId> {
    let info = gio::DBusNodeInfo::for_xml(XML)
        .ok()?
        .lookup_interface("com.canonical.dbusmenu")?;
    connection
        .register_object(
            "/Menu",
            &info,
            move |_, _, _, _, method, parameters, invocation| match method {
                "GetLayout" => {
                    let children: Vec<Variant> = entries()
                        .into_iter()
                        .map(|(id, properties)| {
                            (id, properties, Vec::<Variant>::new()).to_variant()
                        })
                        .collect();
                    let properties =
                        HashMap::from([("children-display".to_owned(), "submenu".to_variant())]);
                    invocation
                        .return_value(Some(&(1u32, (0i32, properties, children)).to_variant()));
                }
                "GetGroupProperties" => invocation.return_value(Some(&(entries(),).to_variant())),
                "GetProperty" => {
                    let (id, key) = parameters.get::<(i32, String)>().unwrap_or_default();
                    let value = entries()
                        .into_iter()
                        .find(|(entry, _)| *entry == id)
                        .and_then(|(_, p)| p.get(&key).cloned())
                        .unwrap_or_else(|| "".to_variant());
                    invocation.return_value(Some(&(value,).to_variant()));
                }
                "AboutToShow" => invocation.return_value(Some(&(true,).to_variant())),
                "Event" => {
                    if let Some((id, event, _, _)) = parameters.get::<(i32, String, Variant, u32)>()
                    {
                        if event == "clicked" {
                            let event = match id {
                                1 => Some(crate::UserEvent::Reveal),
                                3 => Some(crate::UserEvent::TrayStop),
                                4 => Some(crate::UserEvent::Desktop),
                                5 => Some(crate::UserEvent::Quit),
                                _ => None,
                            };
                            if let Some(event) = event {
                                let _ = proxy.send_event(event);
                            }
                        }
                    }
                    invocation.return_value(None);
                }
                _ => invocation.return_dbus_error(
                    "org.freedesktop.DBus.Error.UnknownMethod",
                    "Unknown tray action",
                ),
            },
            |_, _, _, _, property| match property {
                "Version" => 3u32.to_variant(),
                "TextDirection" => "ltr".to_variant(),
                "Status" => "normal".to_variant(),
                _ => "".to_variant(),
            },
            |_, _, _, _, _, _| false,
        )
        .ok()
}
