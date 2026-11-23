"""Publish an already verified folder to the separate rolling Rust release.

The registry archive is the reader's unit of publication: its signed index and
signatures swap together. Immutable package assets are uploaded before that swap.
This module never uses or creates signing keys.
"""
from pathlib import Path
import hashlib
import shutil
import json
import os
import subprocess
import sys
import zipfile

TAG = "rust-modules"

def publish(stage, repository, run_id, run, existing_names=(), bootstrap=None):
    stage = Path(stage)
    # Build the complete replacement before touching the release.
    archive = stage.parent / "registry.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as output:
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                info=zipfile.ZipInfo(file.relative_to(stage).as_posix(),date_time=(1980,1,1,0,0,0))
                info.external_attr=0o100644 << 16
                output.writestr(info,file.read_bytes())
    for file in sorted((stage / "packages").iterdir()):
        if file.name not in existing_names:
            run(["release", "upload", TAG, str(file), "--repo", repository])
    if bootstrap is not None:
        binary = Path(bootstrap)
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        asset = stage.parent / f"bootstrap-linux-{digest}"
        shutil.copyfile(binary, asset)
        if asset.name not in existing_names:
            run(["release", "upload", TAG, str(asset), "--repo", repository])
    # The signed index and its packages travel together in this final asset.
    # gh --clobber may briefly remove the old asset during replacement.
    run(["release", "upload", TAG, str(archive), "--repo", repository, "--clobber"])

if __name__ == "__main__":
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise SystemExit("Rust registry publication requires manual dispatch")
    repository=sys.argv[2]
    result=subprocess.run(["gh","release","view",TAG,"--repo",repository,"--json","assets"],capture_output=True,text=True)
    if result.returncode:
        subprocess.run(["gh","release","create",TAG,"--repo",repository,"--title","Rust module registry","--notes","Signed Rust module packages and the complete registry snapshot.","--target",os.environ["GITHUB_SHA"]],check=True)
        existing=[]
    else:
        existing=[a["name"] for a in json.loads(result.stdout)["assets"]]
    publish(Path(sys.argv[1]), repository, sys.argv[3],
            lambda args: subprocess.run(["gh", *args], check=True),existing, Path(sys.argv[4]))
