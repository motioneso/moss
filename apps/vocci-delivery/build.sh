#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.12.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
sdk_path="${ANDROID_SDK_ROOT:-$HOME/.local/share/android-sdk}"
build_tools="$sdk_path/build-tools/35.0.0"
android_jar="$sdk_path/platforms/android-35/android.jar"
build_mode="${1:-development}"
if [[ "$build_mode" != development && "$build_mode" != release ]]; then
  printf '%s\n' 'Usage: build.sh [development|release]' >&2; exit 2
fi
if [[ "$build_mode" == release ]]; then
  : "${VOCCI_RELEASE_KEYSTORE:?Set an existing release keystore path}"
  : "${VOCCI_RELEASE_STORE_PASSWORD_FILE:?Set a private password file path}"
  : "${VOCCI_RELEASE_KEY_PASSWORD_FILE:?Set a private key password file path}"
  : "${VOCCI_RELEASE_KEY_ALIAS:?Set the release key alias}"
  : "${VOCCI_RELEASE_VERSION_CODE:?Set a monotonically increasing positive integer}"
  : "${VOCCI_RELEASE_VERSION_NAME:?Set a release version name}"
fi
rm -rf build/classes build/dex
mkdir -p build/classes build/dex
sources=(src/ai/moss/vocci/*.java)
if [[ "$build_mode" == release ]]; then
  sources=(); for source in src/ai/moss/vocci/*.java; do
    [[ "$source" == *Checks.java ]] || sources+=("$source")
  done
fi
javac --release 11 -cp "$android_jar" -d build/classes "${sources[@]}"
"$build_tools/d8" --lib "$android_jar" --min-api 33 --output build/dex build/classes/ai/moss/vocci/*.class
manifest_path=AndroidManifest.xml
if [[ "$build_mode" == release ]]; then
  python3 - <<'PY'
import os
import re
import xml.etree.ElementTree as ET
ns = 'http://schemas.android.com/apk/res/android'
ET.register_namespace('android', ns)
attr = lambda name: '{' + ns + '}' + name
code, name = os.environ['VOCCI_RELEASE_VERSION_CODE'], os.environ['VOCCI_RELEASE_VERSION_NAME']
if not re.fullmatch(r'[1-9][0-9]{0,8}', code) or not re.fullmatch(r'[A-Za-z0-9.+-]{1,32}', name):
    raise SystemExit('Invalid release version')
tree = ET.parse('AndroidManifest.xml'); root = tree.getroot()
root.set(attr('versionCode'), code); root.set(attr('versionName'), name)
app = root.find('application')
app.set(attr('debuggable'), 'false'); app.set(attr('usesCleartextTraffic'), 'false')
app.set(attr('label'), 'Moss ring companion')
for item in root.findall('instrumentation'): root.remove(item)
tree.write('build/AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
PY
  manifest_path=build/AndroidManifest.xml
fi
"$build_tools/aapt2" link -I "$android_jar" --manifest "$manifest_path" -A assets -o build/unsigned.apk
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
with ZipFile('build/unsigned.apk', 'a') as apk:
    for path in Path('build/dex').glob('*.dex'):
        apk.write(path, path.name)
PY
"$build_tools/zipalign" -f 4 build/unsigned.apk build/aligned.apk
if [[ "$build_mode" == release ]]; then
  key_password_args=()
  # apksigner consumes successive lines when one file is named twice. With a
  # shared password file, let it reuse the store password for the key instead.
  if [[ ! "$VOCCI_RELEASE_STORE_PASSWORD_FILE" -ef "$VOCCI_RELEASE_KEY_PASSWORD_FILE" ]]; then
    key_password_args=(--key-pass "file:$VOCCI_RELEASE_KEY_PASSWORD_FILE")
  fi
  "$build_tools/apksigner" sign --ks "$VOCCI_RELEASE_KEYSTORE" --ks-key-alias "$VOCCI_RELEASE_KEY_ALIAS" \
    --ks-pass "file:$VOCCI_RELEASE_STORE_PASSWORD_FILE" "${key_password_args[@]}" \
    --out build/moss-vocci-release.apk build/aligned.apk
  "$build_tools/apksigner" verify build/moss-vocci-release.apk
  printf '%s\n' 'Built release APK: apps/vocci-delivery/build/moss-vocci-release.apk'
  exit 0
fi
if [[ ! -f build/development.keystore ]]; then
  keytool -genkeypair -keystore build/development.keystore -storepass android -keypass android -alias development -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=Moss Development Only' >/dev/null 2>&1
fi
"$build_tools/apksigner" sign --ks build/development.keystore --ks-pass pass:android --out build/moss-vocci-dev.apk build/aligned.apk
"$build_tools/apksigner" verify build/moss-vocci-dev.apk
printf '%s\n' 'Built development-only APK: apps/vocci-delivery/build/moss-vocci-dev.apk'
