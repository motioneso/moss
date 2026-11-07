#!/usr/bin/env bash
# Plants one bug at a time in a copy of the Rust Tasks server and checks that the side-by-side
# run catches each one. Copies come from git HEAD, so the working tree is never edited.
#
#   scripts/run-gate.sh start --gate rust-spike/tools/plant-parity-bugs.sh
#
# Exits 0 only when every planted bug makes the smoke cases fail.
set -euo pipefail
[ "${JARVIS_GATE_RUN:-}" = "1" ] || { echo "refusing: not inside a gate run" >&2; exit 3; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
work="$root/rust-spike/target/planted"
rm -rf "$work"
mkdir -p "$work/bin"

build() {
  local name=$1 file=$2 expr=$3 dir="$work/src-$1"
  mkdir -p "$dir"
  git -C "$root" archive HEAD rust-spike | tar -x -C "$dir"
  local target="$dir/rust-spike/$file"
  cp "$target" "$target.orig"
  sed -i "$expr" "$target"
  if cmp -s "$target" "$target.orig"; then
    echo "$name: the bug did not apply to $file" >&2
    exit 2
  fi
  diff -u "$target.orig" "$target" > "$work/$name.diff" || true
  (cd "$dir/rust-spike" && CARGO_TARGET_DIR="$work/target" cargo build --release --quiet -p tasks)
  cp "$work/target/release/tasks" "$work/bin/tasks-$name"
}

# Every request runs as user A, whoever signed in.
build wrong-actor platform/src/db.rs \
  's/&\[&access\.actor_user_id()\.to_string(), &access\.request_id()\]/\&[\&"00000000-0000-4000-8000-000000000001".to_string(), \&access.request_id()]/'

# Creating a task answers 200 instead of 201.
build create-200 tasks/src/routes.rs \
  's/Ok(json_reply(201, &json!({ "task": task })))/Ok(json_reply(200, \&json!({ "task": task })))/'

# The deferred-status job writes the wrong status.
build job-wrong-status tasks/src/jobs.rs \
  's/Some("done") => TaskStatus::Done,/Some("done") => TaskStatus::Todo,/'

missed=0
for name in wrong-actor create-200 job-wrong-status; do
  set +e
  PARITY_OUT="$work/run-$name" PARITY_COPY_PREFIX=planted \
    "$root/rust-spike/parity/run-parity.sh" --rs-bin "$work/bin/tasks-$name" --only smoke \
    > "$work/run-$name.log" 2>&1
  rc=$?
  set -e
  grep -E '^(FAIL|PARITY)|^ +step|^ +rows' "$work/run-$name.log" | head -12
  if [ "$rc" -eq 1 ]; then
    echo "$name: caught (exit 1)"
  else
    echo "$name: MISSED (exit $rc)"
    missed=$((missed + 1))
  fi
done
[ "$missed" -eq 0 ]
