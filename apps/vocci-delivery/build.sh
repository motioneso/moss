#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.12.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
sdk_path="${ANDROID_SDK_ROOT:-$HOME/.local/share/android-sdk}"
build_tools="$sdk_path/build-tools/35.0.0"
android_jar="$sdk_path/platforms/android-35/android.jar"
rm -rf build/classes build/dex
mkdir -p build/classes build/dex
javac --release 11 -cp "$android_jar" -d build/classes src/ai/moss/vocci/*.java
"$build_tools/d8" --lib "$android_jar" --min-api 33 --output build/dex build/classes/ai/moss/vocci/*.class
"$build_tools/aapt2" link -I "$android_jar" --manifest AndroidManifest.xml -o build/unsigned.apk
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
with ZipFile('build/unsigned.apk', 'a') as apk:
    for path in Path('build/dex').glob('*.dex'):
        apk.write(path, path.name)
PY
"$build_tools/zipalign" -f 4 build/unsigned.apk build/aligned.apk
if [[ ! -f build/development.keystore ]]; then
  keytool -genkeypair -keystore build/development.keystore -storepass android -keypass android -alias development -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=Moss Development Only' >/dev/null 2>&1
fi
"$build_tools/apksigner" sign --ks build/development.keystore --ks-pass pass:android --out build/moss-vocci-dev.apk build/aligned.apk
"$build_tools/apksigner" verify build/moss-vocci-dev.apk
printf '%s\n' 'Built development-only APK: apps/vocci-delivery/build/moss-vocci-dev.apk'
