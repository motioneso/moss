#!/bin/bash
# Runs ON THE MAC. Signs a copy of the bundle with the hardened runtime and checks whether its
# Postgres loads pgvector under library validation. Prints no identity or team names.
#
#   sign.sh identity   sign with the Apple Development identity (needs an unlocked login
#                          keychain, so run it in Terminal on the Mac, not over SSH)
#   sign.sh adhoc      sign with ad hoc signatures, which needs no key
set -uo pipefail
S=~/moss-js37; SIGNED=$S/signed; MODE=${1:-identity}; HERE=$(cd "$(dirname "$0")" && pwd)
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
team_of() { codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
clean() { sed -E -e "s|$HOME|~|g" -e 's/^(Authority=[A-Za-z ]+):.*/\1: <name>/' -e 's/TeamIdentifier=.*/TeamIdentifier=<team>/' -e 's/^Identifier=.*/Identifier=<id>/' ${TEAM:+-e "s/$TEAM/<team>/g"}; }
flows() { P=$SIGNED bash $HERE/flows.sh "$@" | clean; }

if [ "$MODE" = identity ]; then
  KEY=$(security find-identity -v -p codesigning | awk '/"Apple Development/ {print $2; exit}')
  [ -n "$KEY" ] || { echo "no Apple Development identity"; exit 1; }
else
  KEY=-
fi
sign() { limit 60 codesign --force --options runtime --timestamp=none --sign "$KEY" "$@" 2>&1; }

echo "== mode $MODE: can this session sign without a prompt?"
probe=$(mktemp /tmp/js37-probe.XXXXXX); cp /usr/bin/true "$probe"
if out=$(sign "$probe"); then echo "yes"; else echo "no: $(echo "$out" | tail -1 | sed 's|^.*: ||')"; rm -f "$probe"; exit 1; fi
rm -f "$probe"

echo "== sign every Mach-O file in a copy of the bundle with the hardened runtime, libraries first"
rm -rf $SIGNED && ditto $S/bundle $SIGNED
files=$(find $SIGNED -type f | while read -r f; do file -b "$f" | grep -q '^Mach-O' && echo "$f"; done)
libs=$(echo "$files" | grep -v '/bin/'); bins=$(echo "$files" | grep '/bin/')
ok=0; bad=0
for f in $libs $bins; do if sign "$f" > /dev/null; then ok=$((ok+1)); else bad=$((bad+1)); echo "  failed: ${f#$SIGNED/}"; fi; done
echo "signed $ok files ($(echo "$libs" | wc -l | tr -d ' ') libraries, $(echo "$bins" | wc -l | tr -d ' ') programs), $bad failed"
TEAM=$(team_of $SIGNED/bin/postgres)
echo "strict verify failures: $(for f in $files; do codesign --verify --strict "$f" 2>/dev/null || echo x; done | wc -l | tr -d ' ')"
codesign -dv $SIGNED/bin/postgres 2>&1 | grep -E '^(CodeDirectory|Signature|Authority|TeamIdentifier|Runtime Version)' | clean

if [ "$MODE" = identity ]; then
  echo "== test 1: pgvector signed ad hoc, loaded by a postgres signed with the identity"
  limit 60 codesign --force --sign - $SIGNED/lib/postgresql/vector.dylib > /dev/null 2>&1
  flows init; flows vector
  echo "== test 2: pgvector signed with the same identity"
  sign $SIGNED/lib/postgresql/vector.dylib > /dev/null
  echo "vector.dylib team matches postgres: $([ "$(team_of $SIGNED/lib/postgresql/vector.dylib)" = "$TEAM" ] && echo yes || echo no)"
  flows vector
else
  echo "== test 1: pgvector and postgres both signed ad hoc with the hardened runtime"
  flows init; flows vector
  echo "== test 2: the same, with library validation switched off for postgres"
  ent=$S/no-library-validation.plist
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>' > $ent
  for f in $bins; do limit 60 codesign --force --options runtime --timestamp=none --entitlements $ent --sign - "$f" > /dev/null 2>&1; done
  echo "postgres entitlements: $(codesign -d --entitlements - --xml $SIGNED/bin/postgres 2>/dev/null | grep -o 'disable-library-validation')"
  flows init; flows vector
fi

echo "== Gatekeeper's view (no quarantine flag, so no first-launch check runs)"
spctl --assess --type execute -vv $SIGNED/bin/postgres 2>&1 | clean | head -4
echo "== syspolicy_check distribution"
limit 120 syspolicy_check distribution $SIGNED/bin/postgres 2>&1 | clean > $S/syspolicy.txt
head -1 $S/syspolicy.txt; echo "errors by kind:"; grep -E '^[A-Z][A-Za-z ]+$' $S/syspolicy.txt | sort | uniq -c
