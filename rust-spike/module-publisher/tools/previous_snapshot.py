"""Fetch the rolling snapshot; only a real HTTP 404 means there is no history."""
from pathlib import Path
import subprocess
import sys
import zipfile

repository=sys.argv[1]
output=Path(sys.argv[2])
result=subprocess.run(["gh","api",f"repos/{repository}/releases/tags/rust-modules"],capture_output=True,text=True)
if result.returncode:
    if "(HTTP 404)" in result.stderr:
        print("No previous Rust registry release")
        raise SystemExit(0)
    raise SystemExit("Could not read previous Rust registry; refusing to reset its history")
subprocess.run(["gh","release","download","rust-modules","--repo",repository,"--pattern","registry.zip","--dir",str(output.parent/"snapshot-download")],check=True)
archive=output.parent/"snapshot-download/registry.zip"
with zipfile.ZipFile(archive) as snapshot:
    total=0
    for entry in snapshot.infolist():
        name=Path(entry.filename)
        if entry.compress_type != zipfile.ZIP_STORED or name.is_absolute() or ".." in name.parts or "\\" in entry.filename:
            raise SystemExit("Invalid registry snapshot path or compression")
        total+=entry.file_size
        if entry.file_size>64*1024*1024 or total>4*1024*1024*1024 or len(snapshot.infolist())>10000:
            raise SystemExit("Registry snapshot exceeds release limits")
    snapshot.extractall(output)
print("Previous snapshot staged; the release builder will authenticate it before use")
