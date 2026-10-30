#!/usr/bin/dash
# Selected lifecycle original only; every operation before exec is a shell builtin.
set -eu
[ "$#" -eq 5 ] || exit 74
[ "$1" = "tsx tests/uat/run-uat.ts $2" ] || exit 74
[ "$3" = "$UAT_HOST_NONCE" ] && [ "$4" = "$UAT_HOST_RESOURCE" ] || exit 74
[ "$5" = "$PPID" ] && [ "$NODE_CHANNEL_FD" = 3 ] || exit 74
case "$2" in
  1133-chat-attachments.uat.spec.ts|runtime-context.uat.spec.ts|3134-reminder-notifications.uat.spec.ts|3135-reminder-edits-real.uat.spec.ts|3136-repeating-reminders-real.uat.spec.ts|3138-repeating-useful-checks-real.uat.spec.ts|3148-side-chat-destination-real.uat.spec.ts|3151-scheduled-owner-read.uat.spec.ts|3152-configured-source-report.uat.spec.ts) ;;
  *) exit 74 ;;
esac
printf '{"type":"shell-held","pid":%s,"ppid":%s,"nonce":"%s","resource":"%s"}\n' "$$" "$PPID" "$3" "$4" >&5
IFS=' ' read -r kind nonce resource pid parent extra <&4
[ "$kind" = exec-ack ] && [ "$nonce" = "$3" ] && [ "$resource" = "$4" ] || exit 74
[ "$pid" = "$$" ] && [ "$parent" = "$PPID" ] && [ -z "$extra" ] || exit 74
exec /usr/bin/node "$UAT_HOST_TSX_CLI" tests/uat/run-uat.ts "$2"
