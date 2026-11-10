"""Stands in for the desktop's notification service on a private session bus.

Usage: notification-service-stub.py <log file>
Writes one JSON line per Notify call: {"title": ..., "body": ...}.
"""
import json
import sys

from gi.repository import Gio, GLib

XML = """<node><interface name="org.freedesktop.Notifications">
<method name="Notify">
<arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
<arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
</method></interface></node>"""

log = open(sys.argv[1], "a", buffering=1)
counter = [0]


def call(conn, sender, path, iface, method, params, invocation):
    args = params.unpack()
    log.write(json.dumps({"title": args[3], "body": args[4]}) + "\n")
    counter[0] += 1
    invocation.return_value(GLib.Variant("(u)", (counter[0],)))


def on_bus(conn, name):
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    conn.register_object(
        "/org/freedesktop/Notifications", node.interfaces[0], call, None, None
    )


Gio.bus_own_name(
    Gio.BusType.SESSION, "org.freedesktop.Notifications",
    Gio.BusNameOwnerFlags.NONE, on_bus, None, None,
)
GLib.MainLoop().run()
