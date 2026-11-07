#!/bin/bash
# Runs ON THE MAC. Copies the build into ~/moss-js37/bundle and makes it self-contained:
# ICU and zstd inside lib/, every load path relative to the file, every Mach-O re-signed ad hoc.
set -euo pipefail
S=~/moss-js37; P=$S/bundle; L=$P/lib
rm -rf $P; cp -R $S/pg $P
for lib in /opt/homebrew/opt/icu4c@79/lib/libicui18n.79.dylib /opt/homebrew/opt/icu4c@79/lib/libicuuc.79.dylib \
           /opt/homebrew/opt/icu4c@79/lib/libicudata.79.dylib /opt/homebrew/opt/zstd/lib/libzstd.1.dylib; do
  cp -L "$lib" $L/; chmod u+w $L/$(basename $lib)
done
macho() { file "$1" | grep -q "Mach-O"; }
# rewrite FILE BASE: point every Homebrew or build-folder library at BASE/<name>.
rewrite() {
  local f=$1 base=$2
  otool -L "$f" | tail -n +2 | awk '{print $1}' | { grep -E "^(/opt/homebrew/|$S/pg/lib/)" || true; } | while read -r dep; do
    install_name_tool -change "$dep" "$base/$(basename "$dep")" "$f" 2>/dev/null
  done
}
for f in $L/*.dylib; do
  macho "$f" || continue
  install_name_tool -id "@loader_path/$(basename "$f")" "$f" 2>/dev/null
  rewrite "$f" "@loader_path"
done
for f in $P/bin/*; do macho "$f" && rewrite "$f" "@executable_path/../lib"; done
for f in $L/postgresql/*.dylib; do macho "$f" && rewrite "$f" "@loader_path/.."; done
# install_name_tool breaks signatures; arm64 refuses to run unsigned code.
for f in $P/bin/* $L/*.dylib $L/postgresql/*.dylib; do
  macho "$f" && codesign --force --sign - "$f" 2>/dev/null
done
echo "# libraries outside the bundle and the system, per file (none expected):"
for f in $P/bin/* $L/*.dylib $L/postgresql/*.dylib; do
  macho "$f" || continue
  otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -v -E "^(/usr/lib/|/System/|@loader_path|@executable_path)" | sed "s|^|$(basename "$f"): |" || true
done
echo "# bundle size: $(du -sh $P | cut -f1); postgres+initdb+libs+extensions only: $(du -ch $P/bin/postgres $P/bin/initdb $L/*.dylib $L/postgresql $P/share | tail -1 | cut -f1)"
echo BUNDLE-OK
