#!/usr/bin/env bash
# Show which agent programs are installed on this box and what each one says
# about the models and effort levels it accepts, so you know what to type into
# the launcher's model questions.
#
# Everything printed here is read from the programs themselves and from your own
# config files. Nothing is baked into the fleet. A program that names no models
# still accepts them -- it just does not advertise a list, so type the name you
# know.
set -uo pipefail

# Pull one option's description out of a --help page, joining the wrapped lines.
option_help() { # <help text on stdin> <flag>
  awk -v flag="$1" '
    index($0, "  " flag " ") == 1 || index($0, "  " flag) == 1 && length($0) == length("  " flag) {
      taking = 1
      line = $0
      sub(/^  [^ ]+( +<[^>]*>)?/, "", line)
      sub(/^ +/, "", line)
      if (line != "") printf "%s ", line
      next
    }
    taking && /^ {20,}[^ ]/ { line = $0; sub(/^ +/, "", line); printf "%s ", line; next }
    taking { exit }
  '
}

# Model names a help page quotes as examples, e.g. 'opus'.
quoted_names() {
  grep -o "'[A-Za-z0-9._-]\+'" | tr -d "'" | sort -u | paste -sd , - | sed 's/,/, /g'
}

# Values a help page lists in brackets, e.g. (low, medium, high).
bracketed_values() {
  grep -o '(\([a-z]\+, \)\+[a-z]\+)' | head -n1 | tr -d '()'
}

report_or_none() { # <value> <what>
  if [ -n "$1" ]; then echo "  $2: $1"; else echo "  $2: the program does not list any"; fi
}

report_claude() {
  command -v claude >/dev/null 2>&1 || { echo "claude: not installed"; return; }
  local help model_help effort_help configured
  help="$(claude --help 2>/dev/null)"
  model_help="$(printf '%s\n' "$help" | option_help --model)"
  effort_help="$(printf '%s\n' "$help" | option_help --effort)"
  echo "claude"
  report_or_none "$(printf '%s\n' "$model_help" | quoted_names)" "models it names"
  report_or_none "$(printf '%s\n' "$effort_help" | bracketed_values)" "effort levels"
  configured="$(jq -r '.model // empty' "$HOME/.claude/settings.json" 2>/dev/null)"
  [ -n "$configured" ] && echo "  your configured default: $configured"
}

report_codex() {
  command -v codex >/dev/null 2>&1 || { echo "codex: not installed"; return; }
  local config model effort seen
  config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  echo "codex"
  report_or_none "$(codex --help 2>/dev/null | option_help --model | quoted_names)" "models it names"
  echo "  effort levels: passed as -c model_reasoning_effort=<level>; the program does not list them"
  if [ -f "$config" ]; then
    model="$(sed -n 's/^model *= *"\([^"]*\)".*/\1/p' "$config" | head -n1)"
    effort="$(sed -n 's/^model_reasoning_effort *= *"\([^"]*\)".*/\1/p' "$config" | head -n1)"
    [ -n "$model" ] && echo "  your configured default: $model"
    [ -n "$effort" ] && echo "  your configured effort: $effort"
    seen="$(sed -n '/^\[tui.model_availability_nux\]/,/^\[/p' "$config" |
      sed -n 's/^"\([^"]*\)".*/\1/p' | paste -sd , - | sed 's/,/, /g')"
    [ -n "$seen" ] && echo "  models your codex config mentions: $seen"
  fi
}

cat <<'TEXT'
Agent programs on this box, and what each says about models.
Type one of these into the launcher as tool/model/effort, for example
claude/<a model it names>/high. A program that lists nothing still takes a
model name -- it just does not advertise one.

TEXT
report_claude
echo
report_codex
