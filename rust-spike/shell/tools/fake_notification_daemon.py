#!/usr/bin/env python3
"""A stand-in for the desktop's alert service, for the click proof only.

It owns org.freedesktop.Notifications on the session bus it is started on, writes each alert
it receives to a log, and when a file named <folder>/click appears it clicks the alert numbered in
the file, or the newest one that offers a default action when the file is empty.  Usage: fake_notification_daemon.py <log> <folder>
"""
import json
import os
import sys

from gi.repository import Gio, GLib

LOG, FOLDER = sys.argv[1], sys.argv[2]
XML = """<node><interface name="org.freedesktop.Notifications">
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
<arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u" direction="in"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/>
<arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface></node>"""
PATH, IFACE = "/org/freedesktop/Notifications", "org.freedesktop.Notifications"
state = {"next": 1, "clickable": None}


def method(conn, sender, path, iface, name, params, invocation):
    if name == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
    elif name == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("fake", "moss-proof", "1", "1.2")))
    elif name == "Notify":
        _app, _replaces, _icon, title, body, actions, _hints, _timeout = params.unpack()
        number = state["next"]
        state["next"] += 1
        if "default" in actions:
            state["clickable"] = number
        with open(LOG, "a") as log:
            log.write(json.dumps({"id": number, "title": title, "body": body, "actions": actions}) + "\n")
        invocation.return_value(GLib.Variant("(u)", (number,)))
    else:
        invocation.return_value(None)


def poll():
    trigger = os.path.join(FOLDER, "click")
    if os.path.exists(trigger):
        wanted = open(trigger).read().strip()
        if not wanted and not state["clickable"]:
            return True
        os.remove(trigger)
        number, state["clickable"] = (int(wanted) if wanted else state["clickable"]), None
        bus.emit_signal(None, PATH, IFACE, "ActionInvoked", GLib.Variant("(us)", (number, "default")))
        bus.emit_signal(None, PATH, IFACE, "NotificationClosed", GLib.Variant("(uu)", (number, 2)))
    return True


def acquired(connection, name):
    global bus
    bus = connection
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    connection.register_object(PATH, node.interfaces[0], method, None, None)
    GLib.timeout_add(150, poll)
    open(os.path.join(FOLDER, "daemon-ready"), "w").close()


Gio.bus_own_name(Gio.BusType.SESSION, IFACE, Gio.BusNameOwnerFlags.NONE, acquired, None, None)
GLib.MainLoop().run()
