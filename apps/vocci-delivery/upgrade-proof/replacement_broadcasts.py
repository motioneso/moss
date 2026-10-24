"""Select package-replacement records and observe receiver delivery."""
import re


def replacement_records(dump, package):
    headers = list(re.finditer(r"(?m)^[ \t]*BroadcastRecord\{([^\s}]+)[^\n]*", dump))
    records = {}
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(dump)
        block = dump[header.start():end]
        block = re.split(r"(?m)^[ \t]*Historical broadcasts summary:", block, maxsplit=1)[0]
        intent = re.search(r"(?m)^[ \t]*Intent \{([^\n]*)\}", block)
        action = "android.intent.action.MY_PACKAGE_REPLACED"
        if (intent and action + "/" in header.group()
                and re.search(r"(?:^|\s)act=" + re.escape(action) + r"(?:\s|$)", intent[1])
                and re.search(r"(?:^|\s)pkg=" + re.escape(package) + r"(?:\s|$)", intent[1])):
            records[header[1]] = block
    return records


def receiver_states(record, package, receiver):
    """Read only the named manifest receiver's own delivery-state section."""
    states = list(re.finditer(r"(?m)^[ \t]*([A-Z_]+)\b[^\n]*#\d+:", record))
    found = []
    for index, state in enumerate(states):
        end = states[index + 1].start() if index + 1 < len(states) else len(record)
        section = record[state.start():end]
        if (re.search(r"(?m)^[ \t]*name=" + re.escape(receiver) + r"[ \t]*$", section)
                and re.search(r"(?m)^[ \t]*packageName=" + re.escape(package) + r"[ \t]*$", section)):
            found.append(state[1])
    return found


def receiver_delivered(record, package, receiver):
    return "DELIVERED" in receiver_states(record, package, receiver)
