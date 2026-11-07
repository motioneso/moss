#!/usr/bin/env bash
# Removes one safety protection at a time from a copy of rust-spike taken from git HEAD and
# checks that a test then fails. A protection test never seen failing proves nothing. The
# working tree is never edited.
#
#   scripts/run-gate.sh start --gate rust-spike/tools/remove-protections.sh [name...]
#
# With names, only those removals run. Exits 0 only when every removal is caught, which means
# its check exits with the code named below. Any other exit, such as a harness error, counts as
# missed. Each removal's diff and full output are kept in $PROTECTIONS_OUT, by default
# rust-spike/target/protections.
set -euo pipefail
[ "${JARVIS_GATE_RUN:-}" = "1" ] || { echo "refusing: not inside a gate run" >&2; exit 3; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
work="${PROTECTIONS_OUT:-$root/rust-spike/target/protections}"
rm -rf "$work"
mkdir -p "$work/bin"
missed=0

wanted() {
  [ "$#" -eq 1 ] && return 0
  local name=$1 pick
  shift
  for pick in "$@"; do [ "$pick" = "$name" ] && return 0; done
  return 1
}

# copy <name>: a fresh copy of rust-spike from git HEAD.
copy() {
  mkdir -p "$work/$1"
  git -C "$root" archive HEAD rust-spike | tar -x -C "$work/$1"
}

# plant <name> <file> <sed expression>: removes a protection in the copy and records the diff.
# An edit that changes nothing stops the run, so a stale pattern cannot pass as caught.
plant() {
  local file="$work/$1/rust-spike/$2"
  cp "$file" "$file.orig"
  sed -i "$3" "$file"
  if cmp -s "$file" "$file.orig"; then
    echo "$1: the removal did not apply to $2" >&2
    exit 2
  fi
  diff -u --label "a/$2" --label "b/$2" "$file.orig" "$file" >> "$work/$1.diff" || true
  rm "$file.orig"
}

# in_copy <name> <command...>: runs a command inside the copy, sharing one build folder.
in_copy() {
  local name=$1
  shift
  (cd "$work/$name/rust-spike" && CARGO_TARGET_DIR="$work/target" "$@")
}

# build_server <name>: the copy's server, for the side-by-side run.
build_server() {
  in_copy "$1" cargo build --release --quiet -p tasks
  cp "$work/target/release/tasks" "$work/bin/tasks-$1"
}

# parity <name> <case filter>: the side-by-side run against the copy's server.
parity() {
  PARITY_OUT="$work/parity-$1" PARITY_COPY_PREFIX=protect \
    "$root/rust-spike/parity/run-parity.sh" --rs-bin "$work/bin/tasks-$1" --only "$2"
}

# expect <name> <exit code that means caught> <command...>
expect() {
  local name=$1 want=$2 rc
  shift 2
  set +e
  "$@" > "$work/$name.log" 2>&1
  rc=$?
  set -e
  grep -E '^(test .* FAILED|error(\[E[0-9]+\])?:|BROKEN|FAIL|PARITY)|^ +(step|rows|log)' \
    "$work/$name.log" | head -12 | sed 's/^/  /'
  if [ "$rc" -eq "$want" ]; then
    echo "$name: caught (exit $rc)"
  else
    echo "$name: MISSED (exit $rc, wanted $want); see $work/$name.log"
    missed=$((missed + 1))
  fi
}

# A module's SQL may touch another module's tables.
if wanted module-sql-owner "$@"; then
  copy module-sql-owner
  plant module-sql-owner platform/src/module_sql.rs 's/^        self\.owned\.contains(name)$/        true/'
  expect module-sql-owner 101 in_copy module-sql-owner cargo test --quiet -p platform module_sql
fi

# A secret can be printed with {:?}.
if wanted secret-debug "$@"; then
  copy secret-debug
  plant secret-debug platform/src/secret.rs 's/^pub struct Secret {$/#[derive(Debug)]\n&/'
  expect secret-debug 101 in_copy secret-debug cargo build --quiet -p platform
fi

# Log lines are written as they come.
if wanted redaction "$@"; then
  copy redaction
  plant redaction platform/src/redact.rs \
    's/^pub fn redact_json(value: &Value) -> Value {$/&\n    return value.clone();/'
  plant redaction platform/src/redact.rs \
    's/^pub fn redact_text(text: &str) -> String {$/&\n    return text.to_owned();/'
  expect redaction 101 in_copy redaction cargo test --quiet -p platform redact
fi

# A vault path may climb out with "..".
if wanted vault-dotdot "$@"; then
  copy vault-dotdot
  plant vault-dotdot vault/src/lib.rs 's/ || \*name == "\.\."//'
  expect vault-dotdot 101 in_copy vault-dotdot cargo test --quiet -p vault
fi

# Sign-up, sign-in and sign-out accept a request from any web page.
if wanted origin-check "$@"; then
  copy origin-check
  plant origin-check platform/src/auth.rs '/^    platform\.origins\.check_/d'
  expect origin-check 101 in_copy origin-check cargo test --quiet -p platform origin
fi

# Raw file access, a secret read, a privileged database URL, a raw print and a second file
# server, each outside the files allowed them.
if wanted static-rules "$@"; then
  copy static-rules
  plant static-rules platform/src/views.rs \
    '$a fn sneak(secret: \&crate::secret::Secret) -> String {\n    eprintln!("{}", secret.expose_secret());\n    let _ = std::env::var("MOSS_BOOTSTRAP_DATABASE_URL");\n    std::fs::read_to_string("/etc/hostname").unwrap_or_default()\n}'
  plant static-rules tasks/src/routes.rs \
    '$a fn files() -> tower_http::services::ServeDir { tower_http::services::ServeDir::new("/") }'
  expect static-rules 1 "$root/rust-spike/tools/check-safety-rules.sh" "$work/static-rules/rust-spike"
fi

# The server starts on a database role that can bypass row-level security. The role guard
# script builds its own copy with the guard off and shows that copy starting.
if wanted role-guard "$@"; then
  expect role-guard 0 "$root/rust-spike/tools/check-role-guard.sh"
fi

# The connector list returns the sealed secret.
if wanted connector-envelope "$@"; then
  copy connector-envelope
  plant connector-envelope platform/src/views.rs \
    's/accounts\.encrypted_secret IS NOT NULL AS has_secret, \\$/accounts.encrypted_secret IS NOT NULL AS has_secret, accounts.encrypted_secret, \\/'
  plant connector-envelope platform/src/views.rs \
    's/"hasSecret": row\.get::<_, bool>("has_secret"),/&\n        "encryptedSecret": row.get::<_, Option<Value>>("encrypted_secret"),/'
  build_server connector-envelope
  expect connector-envelope 1 parity connector-envelope "safety: connectors"
fi

# Requests run on a connection that skips row-level security, so an admin reads everything.
if wanted admin-bypass "$@"; then
  copy admin-bypass
  plant admin-bypass tasks/src/main.rs 's/"MOSS_APP_DATABASE_URL", 4/"MOSS_BOOTSTRAP_DATABASE_URL", 4/'
  plant admin-bypass platform/src/db.rs 's/if name != expected {/if false \&\& name != expected {/'
  plant admin-bypass platform/src/db.rs 's/if superuser || bypass {/if false \&\& (superuser || bypass) {/'
  build_server admin-bypass
  expect admin-bypass 1 parity admin-bypass "safety: admin"
fi

# Sign-in prints the request body, password included.
if wanted password-logged "$@"; then
  copy password-logged
  plant password-logged platform/src/auth.rs \
    '/^async fn sign_in(/,/^}/ s/^    let body = parse_body(&body)\.ok_or(fail(400, "VALIDATION_ERROR", "Invalid body"))?;$/&\n    eprintln!("sign-in body: {body}");/'
  build_server password-logged
  expect password-logged 1 parity password-logged "safety: password"
fi

[ "$missed" -eq 0 ]
