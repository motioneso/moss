"""Exact package-set and digest comparison across the three CI runners."""
import hashlib
import json
from pathlib import Path
import sys

if sys.argv[1] == "write":
    packages = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(sys.argv[2]).glob("*.mosspkg"))}
    if not packages:
        raise SystemExit("No packages to compare")
    Path(sys.argv[3]).write_text(json.dumps(packages, sort_keys=True, indent=2) + "\n")
elif sys.argv[1] == "compare":
    reports = [(path, json.loads(Path(path).read_text())) for path in sys.argv[2:]]
    if len(reports) != 3 or not reports[0][1]:
        raise SystemExit("Expected three nonempty platform digest reports")
    for name, report in reports[1:]:
        if report != reports[0][1]:
            differences = [p for p in sorted(report.keys() | reports[0][1].keys()) if report.get(p) != reports[0][1].get(p)]
            raise SystemExit(f"Package digests differ on {name}: {', '.join(differences)}")
    print(f"All {len(reports[0][1])} package digests match across the three reports")
else:
    raise SystemExit("Usage: compare_digests.py write PACKAGES REPORT | compare LINUX MACOS WINDOWS")
