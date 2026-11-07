#!/bin/bash
# Runs ON THE MAC, which has no Rust: the supervisor's steps done by hand, same flags as Linux.
# Usage: flows.sh init|lifecycle|leftovers|crash LIMIT|vector|stop   (P=bundle folder to use)
set -uo pipefail
S=~/moss-js37; P=${P:-$S/bundle}; R=$S/run; D=$R/db
CLUSTER=moss-$(printf %s "$D" | shasum -a 256 | cut -c1-12)
ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
q() { PGPASSFILE=$R/secrets/pgpass "$P/bin/psql" -X -q -A -t -h $R/run -U moss_admin "$@"; }
pm() { head -1 $D/postmaster.pid 2>/dev/null; }
strip() { sed -E 's/^[0-9-]+ [0-9:.]+ [A-Z]+ \[[0-9]+\] //'; }
gone() { while kill -0 "$1" 2>/dev/null; do sleep 0.05; done; }

# The lock file names the new postmaster and says "ready". A leftover file from a killed
# server also says "ready", so the pid must match too.
wait_ready() {
  local want=$1 i=0
  until [ "$(pm)" = "$want" ] && [ "$(sed -n 8p $D/postmaster.pid 2>/dev/null | tr -d ' ')" = ready ]; do
    kill -0 "$want" 2>/dev/null || { echo "POSTGRES EXITED"; tail -5 $R/logs/postgres.log | strip; return 1; }
    i=$((i+1)); [ $i -gt 600 ] && { echo "NOT READY"; tail -5 $R/logs/postgres.log | strip; return 1; }
    sleep 0.05
  done
}

# start CORE_LIMIT: start Postgres the way the supervisor does.
start() {
  ( ulimit -c "$1"; cd $R && exec "$P/bin/postgres" -D $D -c listen_addresses= -c port=5432 \
      -c unix_socket_directories=$R/run -c unix_socket_permissions=0700 -c ssl=off \
      -c password_encryption=scram-sha-256 -c max_connections=50 -c cluster_name=$CLUSTER \
      -c logging_collector=off -c lc_messages=C >> $R/logs/postgres.log 2>&1 < /dev/null ) &
  local pid=$!; disown; wait_ready $pid
}
stop_fast() { local p; p=$(pm); [ -n "$p" ] && kill -INT "$p" 2>/dev/null && gone "$p"; return 0; }
busy() { q -d moss_proof -c "DO \$\$ BEGIN WHILE clock_timestamp() < now() + interval '$1 seconds' LOOP END LOOP; END \$\$" > /dev/null 2>&1 & disown; }
backend_pid() { local i=0 p=""; until [ -n "$p" ]; do p=$(ps -axww -o pid=,command= | awk '/moss_proof \[local\] DO/ {print $1; exit}'); i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done; echo "$p"; }

case ${1:-} in
init)
  stop_fast
  rm -rf $R; mkdir -m 700 $R; mkdir -m 700 $R/run $R/logs $R/secrets
  # A random superuser password, written owner-only and never printed.
  ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > $R/secrets/moss_admin
    printf '*:*:*:moss_admin:%s\n' "$(cat $R/secrets/moss_admin)" > $R/secrets/pgpass )
  t=$(ms)
  "$P/bin/initdb" -D $D.partial -U moss_admin --encoding=UTF8 --no-instructions --data-checksums \
    --pwfile=$R/secrets/moss_admin --auth-local=scram-sha-256 --auth-host=scram-sha-256 \
    --locale-provider=icu --icu-locale=und --lc-collate=C --lc-ctype=C.UTF-8 \
    --lc-messages=C --lc-monetary=C --lc-numeric=C --lc-time=C > $R/logs/initdb.log 2>&1 \
    || { echo "INITDB FAILED"; tail -5 $R/logs/initdb.log; exit 1; }
  printf '%s\n' '# Written by the Moss database supervisor. Every connection needs a password (SCRAM).' \
    'local   all   all                  scram-sha-256' 'host    all   all   127.0.0.1/32   scram-sha-256' \
    'host    all   all   ::1/128        scram-sha-256' > $D.partial/pg_hba.conf
  mv $D.partial $D
  echo "initdb: ok in $(( $(ms) - t )) ms; folder modes: root $(stat -f %Lp $R), data $(stat -f %Lp $D), secrets $(stat -f %Lp $R/secrets/moss_admin)"
  ;;
lifecycle)
  t=$(ms); start 0 || exit 1; echo "start: ready in $(( $(ms) - t )) ms"
  echo "network sockets held by the postmaster: $(lsof -a -p "$(pm)" -i 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
  echo "socket file: $(stat -f '%Sp %N' $R/run/.s.PGSQL.5432 | sed "s|$S|~/moss-js37|"), run folder mode $(stat -f %Lp $R/run)"
  echo "wrong password refused: $(PGPASSWORD=wrong "$P/bin/psql" -X -w -h $R/run -U moss_admin -d postgres -c 'SELECT 1' 2>&1 | grep -o 'password authentication failed' | head -1)"
  q -d postgres -c "SELECT version()" | cut -c1-80
  q -d postgres -c "SELECT 'checksums ' || current_setting('data_checksums') || ', cluster ' || current_setting('cluster_name') || ', collation provider ' || datlocprovider::text || ' ' || coalesce(datlocale, '') || ', ctype ' || datctype FROM pg_database WHERE datname = 'postgres'"
  q -d postgres -c "CREATE DATABASE moss_proof"
  q -d moss_proof -c "CREATE EXTENSION vector" \
    -c "CREATE TABLE items (id int PRIMARY KEY, label text NOT NULL, embedding vector(3) NOT NULL)" \
    -c "INSERT INTO items VALUES (1, 'east', '[1,0,0]'), (2, 'north', '[0,1,0]'), (3, 'up', '[0,0,1]'), (4, 'north-east', '[0.7,0.7,0]')" \
    -c "CREATE INDEX items_embedding ON items USING hnsw (embedding vector_l2_ops)" \
    -c "CREATE TABLE marks (id bigserial PRIMARY KEY, note text NOT NULL)" \
    -c "INSERT INTO marks (note) VALUES ('written before the clean stop')"
  echo "vector $(q -d moss_proof -c "SELECT extversion FROM pg_extension WHERE extname = 'vector'"); nearest to [0.9,0.6,0]:"
  q -d moss_proof -F ' ' -c "SELECT label, round((embedding <-> '[0.9,0.6,0]')::numeric, 4) FROM items ORDER BY embedding <-> '[0.9,0.6,0]' LIMIT 2"
  q -d moss_proof -c "BEGIN" -c "SET LOCAL enable_seqscan = off" -c "EXPLAIN (COSTS OFF) SELECT id FROM items ORDER BY embedding <-> '[0.9,0.6,0]' LIMIT 2" -c "COMMIT" | grep -i index
  echo "sort order under ICU und: $(q -d moss_proof -c "SELECT string_agg(w, ' ' ORDER BY w) FROM unnest(ARRAY['apple','Zebra','éclair','Eagle']) w")"
  t=$(ms); stop_fast; echo "clean stop: $(( $(ms) - t )) ms; log says: $(grep 'database system is shut down' $R/logs/postgres.log | tail -1 | strip)"
  t=$(ms); start 0 || exit 1; echo "restart: ready in $(( $(ms) - t )) ms"
  echo "after restart, marks: $(q -d moss_proof -c "SELECT string_agg(note, ', ') FROM marks")"
  q -d moss_proof -c "INSERT INTO marks (note) VALUES ('written just before the hard kill')"
  p=$(pm); kill -KILL "$p"; gone "$p"; echo "postmaster killed with SIGKILL"
  t=$(ms); start 0 || exit 1; echo "start after the kill: ready in $(( $(ms) - t )) ms"
  grep -E "was interrupted|not properly shut down|redo starts|redo done|ready to accept" $R/logs/postgres.log | tail -4 | strip | cut -c1-110
  echo "after crash recovery, marks: $(q -d moss_proof -c "SELECT string_agg(note, ', ' ORDER BY id) FROM marks")"
  echo "checksum failures so far: $(q -d postgres -c "SELECT coalesce(sum(checksum_failures), 0) FROM pg_stat_database")"
  ;;
leftovers)
  busy 120; b=$(backend_pid); p=$(pm)
  echo "titles as macOS ps shows them (pid uid ucomm command):"
  ps -axww -o pid=,uid=,ucomm=,command= | grep -F -e "$CLUSTER" -e "-D $D" | grep -v grep | sed -E "s|$S|~/moss-js37|g; s/^ *[0-9]+ +[0-9]+ /<pid> <uid> /" | cut -c1-130
  kill -KILL "$p"; gone "$p"; sleep 1
  echo "postmaster killed with SIGKILL; busy backend still alive: $(kill -0 "$b" 2>/dev/null && echo yes || echo no)"
  echo "orphan's title now: $(ps -o command= -p "$b" | cut -c1-80)"
  echo "Postgres alone now says:"; ( ulimit -c 0; "$P/bin/postgres" -D $D -c listen_addresses= -c unix_socket_directories=$R/run -c cluster_name=$CLUSTER 2>&1 | grep -E "FATAL|HINT" | head -2 | strip )
  echo "ending leftovers matched by title, as the supervisor would:"
  for x in $(ps -axww -o pid=,command= | awk -v c="postgres: $CLUSTER: " 'index($0, c) {print $1}'); do kill -QUIT "$x"; gone "$x"; echo "  ended one (SIGQUIT)"; done
  t=$(ms); start 0 || exit 1; echo "start after clearing leftovers: ready in $(( $(ms) - t )) ms; marks rows: $(q -d moss_proof -c 'SELECT count(*) FROM marks')"
  ;;
crash)
  # crash LIMIT: SIGSEGV a busy backend whose Postgres runs with core limit LIMIT.
  limit=${2:-0}
  stop_fast; start "$limit" || exit 1
  busy 120; b=$(backend_pid)
  marker=$R/crash-marker; touch $marker; sleep 1
  echo "core limit $limit: kern.coredump=$(sysctl -n kern.coredump), kern.corefile=$(sysctl -n kern.corefile), backend limit $(ps -o pid= -p "$b" >/dev/null && echo set)"
  kill -SEGV "$b"; sleep 10
  grep -F "PID $b)" $R/logs/postgres.log | strip | cut -c1-110
  echo "new files in /cores:"; find /cores -newer $marker -type f -exec ls -l {} \; 2>/dev/null | awk '{print $5, $9}' | sed -E 's/core\.[0-9]+/core.<pid>/' | grep . || echo "(none)"
  echo "new crash reports:"; find ~/Library/Logs/DiagnosticReports -newer $marker -type f 2>/dev/null | sed -E "s|$HOME|~|; s/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+/<time>/" | grep . || echo "(none)"
  ;;
vector)
  # Whether this bundle's Postgres can load pgvector.
  start 0 || exit 1
  q -d postgres -c "DROP DATABASE IF EXISTS sign_test" -c "CREATE DATABASE sign_test"
  if out=$(q -d sign_test -c "CREATE EXTENSION vector" -c "SELECT '[1,2]'::vector <-> '[2,2]'::vector" 2>&1); then
    echo "CREATE EXTENSION vector: ok (distance $out)"
  else
    echo "CREATE EXTENSION vector: FAILED"; echo "$out" | head -2 | sed "s|$HOME|~|g" | fold -w 120
  fi
  stop_fast
  ;;
stop) t=$(ms); stop_fast; echo "clean stop: $(( $(ms) - t )) ms" ;;
*) echo "unknown step"; exit 2 ;;
esac
