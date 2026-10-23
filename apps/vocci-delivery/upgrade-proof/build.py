#!/usr/bin/env python3
"""Build production sources under a distinct, disposable installed-test identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
from zipfile import ZipFile

PACKAGE = "ai.moss.vocci.upgradeproof"
HERE = Path(__file__).resolve().parent
ANDROID = "http://schemas.android.com/apk/res/android"
ATTR = lambda name: "{" + ANDROID + "}" + name
ET.register_namespace("android", ANDROID)


def run(*args):
    subprocess.run([str(value) for value in args], check=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="apps/vocci-delivery directory")
    parser.add_argument("--out", required=True, type=Path, help="new private output directory")
    parser.add_argument("--key", required=True, type=Path, help="same disposable signing key for both builds")
    parser.add_argument("--version", required=True, type=int)
    args = parser.parse_args()
    source, out, key = args.source.resolve(), args.out.resolve(), args.key.resolve()
    out.mkdir(parents=True, exist_ok=False)
    java = Path(os.environ.get("JAVA_HOME", str(Path.home() / ".local/opt/jdk-21.0.12.1+1"))) / "bin"
    os.environ["JAVA_HOME"] = str(java.parent)
    os.environ["PATH"] = str(java) + os.pathsep + os.environ.get("PATH", "")
    sdk = Path(os.environ.get("ANDROID_SDK_ROOT", str(Path.home() / ".local/share/android-sdk")))
    android_jar, build_tools = sdk / "platforms/android-35/android.jar", sdk / "build-tools/35.0.0"
    classes, dex = out / "classes", out / "dex"
    classes.mkdir(); dex.mkdir()
    sources = sorted((source / "src/ai/moss/vocci").glob("*.java"))
    sources.append(HERE / "UpgradeFixture.java")
    selection = source / "proof/src/ai/moss/vocci/SetupSelectionChecks.java"
    selection_digest = None
    if selection.exists():
        # Keep the isolation guard; substitute only the explicitly owned test package.
        original = selection.read_text()
        assert original.count('"ai.moss.vocci.setupproof"') == 1
        adapted = out / "SetupSelectionChecks.java"
        adapted.write_text(original.replace('"ai.moss.vocci.setupproof"', '"' + PACKAGE + '"'))
        sources.append(adapted)
        selection_digest = digest(selection)
    run(java / "javac", "--release", "11", "-cp", android_jar, "-d", classes, *sources)
    run(build_tools / "d8", "--lib", android_jar, "--min-api", "33", "--output", dex,
        *sorted(classes.rglob("*.class")))
    tree = ET.parse(source / "AndroidManifest.xml")
    root = tree.getroot()
    original_package = root.get("package")
    root.set("package", PACKAGE)
    root.set(ATTR("versionCode"), str(args.version))
    root.set(ATTR("versionName"), "upgrade-proof-" + str(args.version))
    app = root.find("application")
    app.set(ATTR("label"), "Moss disposable upgrade proof")
    for item in app:
        name = item.get(ATTR("name"))
        if name and name.startswith("."):
            item.set(ATTR("name"), original_package + name)
    for item in root.findall("instrumentation"):
        root.remove(item)
    for name in ["UpgradeFixture"] + (["SetupSelectionChecks"] if selection.exists() else []):
        ET.SubElement(root, "instrumentation", {ATTR("name"): "ai.moss.vocci." + name,
            ATTR("targetPackage"): PACKAGE, ATTR("functionalTest"): "true"})
    manifest = out / "AndroidManifest.xml"
    tree.write(manifest, encoding="utf-8", xml_declaration=True)
    unsigned, aligned, apk = [out / name for name in ("unsigned.apk", "aligned.apk", "upgrade-proof.apk")]
    run(build_tools / "aapt2", "link", "-I", android_jar, "--manifest", manifest,
        "-A", source / "assets", "-o", unsigned)
    with ZipFile(unsigned, "a") as archive:
        for path in sorted(dex.glob("*.dex")):
            archive.write(path, path.name)
    run(build_tools / "zipalign", "-f", "4", unsigned, aligned)
    if not key.exists():
        key.parent.mkdir(parents=True, exist_ok=True)
        run(java / "keytool", "-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android",
            "-alias", "upgrade-proof", "-keyalg", "RSA", "-keysize", "2048", "-validity", "30",
            "-dname", "CN=Disposable Installed Upgrade Proof")
    run(build_tools / "apksigner", "sign", "--ks", key, "--ks-pass", "pass:android", "--out", apk, aligned)
    run(build_tools / "apksigner", "verify", apk)
    inputs = {str(path.relative_to(source)): digest(path) for path in sources if path.is_relative_to(source)}
    metadata = {"package": PACKAGE, "version": args.version, "apkSha256": digest(apk),
        "sourceFiles": inputs, "fixtureSha256": digest(HERE / "UpgradeFixture.java"),
        "selectionOriginalSha256": selection_digest, "manifestOriginalSha256": digest(source / "AndroidManifest.xml")}
    (out / "build-receipt.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({key: metadata[key] for key in ("package", "version", "apkSha256")}))


if __name__ == "__main__":
    main()
