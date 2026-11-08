# Builds the shared case list for the permission-policy parity check.
import itertools, json
cwd, home = "/srv/acct/work", "/home/p"
names = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
         "ExitPlanMode", "TodoWrite", "mcp__moss__notes_search", "mcp__other__x", "NotebookEdit",
         "read", "write", "edit", "bash", "glob", "grep", "webfetch", "moss_notes_search",
         "Made Up", None]
paths = [None, f"{cwd}/a.txt", f"{cwd}/../escape.txt", "/etc/passwd", f"{home}/.ssh/id_ed25519",
         f"{home}/notes.md", "relative/b.txt", "../up.txt"]
urls = ["https://example.com/x", "http://127.0.0.1:8080/", "http://192.168.1.4/", "http://[::1]/",
        "https://localhost/", "http://10.0.0.1/", "not a url"]
cases = []
for n, p in itertools.product(names, paths):
    raw = {} if p is None else {"file_path": p}
    cases.append({"tool": n, "raw": raw, "locations": []})
    if p is not None:
        cases.append({"tool": n, "raw": {}, "locations": [p]})
for n, u in itertools.product(["WebFetch", "webfetch", "WebSearch"], urls):
    cases.append({"tool": n, "raw": {"url": u}, "locations": []})
for c in cases:
    c["cwd"], c["home"] = cwd, home
cases.append({"tool": "Read", "raw": {"file_path": f"{cwd}/x"}, "locations": [], "cwd": cwd, "home": None})
print(json.dumps(cases, indent=0))
