"""Fetch the rolling snapshot; only a real HTTP 404 or an unpublished draft may lack history."""
from pathlib import Path
import json
import subprocess
import sys
import zipfile

def fetch(repository, output, run=subprocess.run):
    output=Path(output)
    result=run(["gh","api",f"repos/{repository}/releases/tags/rust-modules"],capture_output=True,text=True)
    if result.returncode:
        if "(HTTP 404)" in result.stderr:
            print("No previous Rust registry release")
            return
        raise SystemExit("Could not read previous Rust registry; refusing to reset its history")
    release=json.loads(result.stdout)
    if not any(asset["name"] == "registry.zip" for asset in release.get("assets", [])):
        if release.get("draft") is True:
            print("Unpublished draft has no snapshot; retrying first publication")
            return
        raise SystemExit("Public Rust release is missing its snapshot; refusing to reset history")
    run(["gh","release","download","rust-modules","--repo",repository,"--pattern","registry.zip","--dir",str(output.parent/"snapshot-download")],check=True)
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

if __name__ == "__main__":
    fetch(sys.argv[1], sys.argv[2])
