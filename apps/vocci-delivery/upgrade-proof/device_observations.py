"""Read current Android adapter/service observations without device I/O."""
import re


def bluetooth_state(dump):
    """Return only an unambiguous current state, never a historical fallback."""
    sections = re.split(r"(?m)^Bluetooth Status:[ \t]*$", dump)
    if len(sections) != 2:
        return None
    current = re.split(r"\n[ \t]*\n|\n(?=\S)", sections[1].lstrip("\n"), maxsplit=1)[0]
    states = re.findall(r"(?m)^[ \t]+State:[ \t]+([^\n]+)", current)
    known = {"ON", "OFF", "TURNING_ON", "TURNING_OFF", "BLE_ON", "BLE_TURNING_ON", "BLE_TURNING_OFF"}
    return states[0].strip() if len(states) == 1 and states[0].strip() in known else None


def live_foreground_service(dump, pids, package, service):
    """Require the exact active service's own foreground flag and live PID."""
    headers = list(re.finditer(r"(?m)^[ \t]*\* ServiceRecord\{[^\n]+", dump))
    records = []
    for index, header in enumerate(headers):
        component = re.search(r"\bu0 " + re.escape(package) + r"/([^\s}]+)", header[0])
        if not component:
            continue
        name = package + component[1] if component[1].startswith(".") else component[1]
        if name == service:
            end = headers[index + 1].start() if index + 1 < len(headers) else len(dump)
            records.append(dump[header.end():end])
    if len(records) != 1:
        return False
    record = records[0]
    processes = re.findall(r"(?m)^[ \t]+app=ProcessRecord\{\S+ (\d+):" + re.escape(package) + r"/[^\n}]+\}[ \t]*$", record)
    flags = re.findall(r"(?m)^[ \t]+isForeground=(true|false)\b", record)
    return len(processes) == 1 and processes[0] in pids.split() and flags == ["true"]
