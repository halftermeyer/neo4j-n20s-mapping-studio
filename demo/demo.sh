#!/usr/bin/env bash
# The demo, from a clean state, as many times as needed.
#
#   demo/demo.sh start     resets the database side (demo/aura.mjs reset), copies
#                          demo/project to demo/.work, starts n20s-server and the
#                          studio on http://127.0.0.1:4500 with the AI answers
#                          replayed from demo/recordings/ai.json
#   demo/demo.sh live      the same, with the live model, recording its answers
#                          to demo/recordings/ai.json (run it once, or after the
#                          prompts or the script changed)
#   demo/demo.sh stop      stops the studio and n20s-server, undoes the demo transactions
#
# Needs: .env (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD of a Neo4j Enterprise or
# Aura instance with Change Data Capture in FULL mode; GEMINI_API_KEY for `live`),
# Java 21, and N20S_JAR (default ../n20s-plugin/n20s-server/target/n20s-server-1.1.0-SNAPSHOT.jar).
set -euo pipefail
cd "$(dirname "$0")/.."
DEMO=demo
WORK=$DEMO/.work
RUN=$DEMO/.run
STUDIO_PORT=${STUDIO_PORT:-4500}
N20S_PORT=${N20S_PORT:-7490}
N20S_JAR=${N20S_JAR:-../n20s-plugin/n20s-server/target/n20s-server-1.1.0-SNAPSHOT.jar}
RECORDING=$DEMO/recordings/ai.json
mkdir -p "$RUN"

stop() {
  for p in studio n20s; do
    if [[ -f $RUN/$p.pid ]]; then kill "$(cat "$RUN/$p.pid")" 2>/dev/null || true; rm -f "$RUN/$p.pid"; fi
  done
}

wait_for() { # url what
  for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "✖ $2 did not start (see $RUN/$2.log)"; exit 1
}

start() {
  local mode=$1
  stop
  echo "▶ database: starting state"
  node $DEMO/aura.mjs reset
  echo "▶ project: fresh copy in $WORK"
  rm -rf "$WORK"
  cp -R $DEMO/project "$WORK"
  echo "▶ n20s-server on $N20S_PORT"
  JAVA=${JAVA_HOME:+$JAVA_HOME/bin/}java
  if [[ -x /usr/libexec/java_home ]]; then JAVA="$(/usr/libexec/java_home -v 21)/bin/java"; fi
  PORT=$N20S_PORT nohup "$JAVA" -jar "$N20S_JAR" >"$RUN/n20s.log" 2>&1 &
  echo $! >"$RUN/n20s.pid"
  wait_for "http://127.0.0.1:$N20S_PORT/version" n20s
  local ai=()
  if [[ $mode == live ]]; then
    rm -f "$RECORDING"
    ai=(--record "$RECORDING")
  else
    [[ -f $RECORDING ]] || { echo "✖ no $RECORDING: run demo/demo.sh live once"; exit 1; }
    ai=(--replay "$RECORDING")
  fi
  echo "▶ studio on http://127.0.0.1:$STUDIO_PORT ($mode)"
  nohup node bin/n20s-mapping.js studio "$WORK/n20s-project.yaml" --port "$STUDIO_PORT" \
    --n20s "http://127.0.0.1:$N20S_PORT" --reviewer Pierre --dotenv .env --mask-hosts --title "RDF mapping studio" "${ai[@]}" >"$RUN/studio.log" 2>&1 &
  echo $! >"$RUN/studio.pid"
  wait_for "http://127.0.0.1:$STUDIO_PORT/" studio
  echo "✔ ready: http://127.0.0.1:$STUDIO_PORT/project"
}

case "${1:-}" in
  start) start replay ;;
  live) start live ;;
  stop) stop; node $DEMO/aura.mjs reset >/dev/null; echo "✔ stopped" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
