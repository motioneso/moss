#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Development-only separate application; never replaces the working companion.
./build.sh
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.12.1+1}"
export PATH="$JAVA_HOME/bin:$PATH"
sdk_path="${ANDROID_SDK_ROOT:-$HOME/.local/share/android-sdk}"
build_tools="$sdk_path/build-tools/35.0.0"
android_jar="$sdk_path/platforms/android-35/android.jar"
rm -rf build/auth-proof/classes build/auth-proof/dex
mkdir -p build/auth-proof/classes build/auth-proof/dex
javac --release 11 -cp "$android_jar:build/classes" -d build/auth-proof/classes proof/src/ai/moss/vocci/*.java
"$build_tools/d8" --lib "$android_jar" --min-api 33 --output build/auth-proof/dex build/classes/ai/moss/vocci/*.class build/auth-proof/classes/ai/moss/vocci/*.class
"$build_tools/aapt2" compile --dir proof/res -o build/auth-proof/resources.zip
"$build_tools/aapt2" link -I "$android_jar" --manifest proof/AndroidManifest.xml -R build/auth-proof/resources.zip -A assets -o build/auth-proof/unsigned.apk
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
with ZipFile('build/auth-proof/unsigned.apk', 'a') as apk:
    for path in Path('build/auth-proof/dex').glob('*.dex'):
        apk.write(path, path.name)
PY
"$build_tools/zipalign" -f 4 build/auth-proof/unsigned.apk build/auth-proof/aligned.apk
"$build_tools/apksigner" sign --ks build/development.keystore --ks-pass pass:android --out build/moss-vocci-auth-proof.apk build/auth-proof/aligned.apk
"$build_tools/apksigner" verify build/moss-vocci-auth-proof.apk
printf '%s\n' 'Built isolated proof APK: apps/vocci-delivery/build/moss-vocci-auth-proof.apk'
