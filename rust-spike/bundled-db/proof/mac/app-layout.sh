#!/bin/bash
# Runs ON THE MAC. Puts the ad hoc signed server inside a throwaway app bundle and asks
# Apple's pre-notarization check what is still wrong. No identity needed.
set -uo pipefail
S=~/moss-js37; APP=$S/Moss-test.app; C=$APP/Contents; HERE=$(cd "$(dirname "$0")" && pwd)
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
clean() { sed -E -e "s|$HOME|~|g"; }
rm -rf $APP && mkdir -p $C/MacOS $C/Helpers
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>moss-test</string><key>CFBundleIdentifier</key><string>org.example.moss-test</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Moss test</string><key>CFBundleVersion</key><string>1</string></dict></plist>' > $C/Info.plist
printf 'int main(void) { return 0; }\n' > $S/stub.c && clang -O2 -o $C/MacOS/moss-test $S/stub.c
ditto $S/bundle $C/Helpers/postgres
# Code folders may hold only code. Build-only files go; runtime data moves to Resources.
H=$C/Helpers/postgres
rm -rf $H/include $H/lib/pkgconfig $H/lib/postgresql/pgxs; find $H/lib -name '*.a' -delete
mkdir -p $C/Resources && mv $H/share $C/Resources/postgres-share && ln -s ../../Resources/postgres-share $H/share
echo "files left in Helpers that are not Mach-O: $(find $H -type f | while read -r f; do file -b "$f" | grep -q '^Mach-O' || echo "$f"; done | wc -l | tr -d ' ')"
echo "size: Helpers $(du -sh $C/Helpers | cut -f1), Resources $(du -sh $C/Resources | cut -f1)"
files=$(find $C/Helpers -type f | while read -r f; do file -b "$f" | grep -q '^Mach-O' && echo "$f"; done)
for f in $(echo "$files" | grep -v /bin/) $(echo "$files" | grep /bin/); do
  limit 60 codesign --force --options runtime --timestamp=none --sign - "$f" > /dev/null 2>&1 || echo "sign failed: ${f#$C/}"
done
echo "== sign the app bundle itself"
limit 60 codesign --force --options runtime --timestamp=none --sign - $APP 2>&1 | clean | tail -3
codesign --verify --strict --deep $APP 2>&1 | clean | tail -3 | sed 's/^/verify: /'; echo "verify exit: ${PIPESTATUS[0]}"
echo "== syspolicy_check distribution on the app"
limit 180 syspolicy_check distribution $APP 2>&1 | clean > $S/syspolicy-app.txt
head -1 $S/syspolicy-app.txt; echo "errors by kind:"; grep -E '^[A-Z][A-Za-z ]+$' $S/syspolicy-app.txt | sort | uniq -c
grep -A3 -E '^(Bad Load Command|Unsealed|Invalid)' $S/syspolicy-app.txt | head -12
echo "== run it from inside the app (programs get library validation off, as in test 2)"
ent=$S/no-library-validation.plist
for f in $(echo "$files" | grep /bin/); do limit 60 codesign --force --options runtime --timestamp=none --entitlements $ent --sign - "$f" > /dev/null 2>&1; done
limit 60 codesign --force --options runtime --timestamp=none --sign - $APP > /dev/null 2>&1
P=$H bash $HERE/flows.sh init | clean; P=$H bash $HERE/flows.sh vector | clean
