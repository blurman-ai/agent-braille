#!/usr/bin/env bash
# Checks the whole project: control cases, runtime tests, and a real React app in a real browser.
set -u
cd "$(dirname "$0")"
ROOT=$PWD; EX=examples/react-mantine; PORT=${PORT:-4310}; BASE=http://127.0.0.1:$PORT; T=$(mktemp -d); FAILS=0; SERVER=
BR="node $ROOT/bin/braille.mjs"
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
stop() { if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; fi; SERVER=; }
serve() { stop; (cd "$EX" && exec node server.mjs "$PORT" "$1") & SERVER=$!; sleep 0.5; }
trap stop EXIT
green() { if "${@:2}" >"$T/o" 2>&1; then ok "$1"; else fail "$1"; cat "$T/o"; fi; }
red()   { # red <title> <required text> <command…>
  local title=$1 wanted=$2; shift 2
  if "$@" >"$T/o" 2>&1; then fail "$title: went green"; cat "$T/o"
  elif grep -rq "$wanted" "$T/o" "$T/runs" 2>/dev/null; then ok "$title"; else fail "$title: no «$wanted»"; cat "$T/o"; fi; }

green "executor and CLI control cases" $BR selftest
green "runtime tests" npx vitest run
green "scenario form" $BR check $EX/scenarios
printf '{"name":"x","why":"y","verifies":["z"],"steps":[{"goto":"/"},{"wait":"t"}]}' > "$T/x.json"
red "control: bad scenario refused" "needs after" $BR run "$T/x.json" --base "$BASE"

[ -d $EX/node_modules ] || (cd $EX && npm install --no-audit --no-fund --silent)
green "install runtime" $BR install $EX
rm -f $EX/src/shared/agent/*.test.ts
echo "// drift" >> $EX/src/shared/agent/busy.ts
red "control: drifted copy reported" "differs" $BR check-runtime $EX
green "install restores it" $BR install $EX
rm -f $EX/src/shared/agent/*.test.ts
(cd $EX && VITE_AGENT_API=1 npx vite build --outDir dist --emptyOutDir --logLevel error) >/dev/null 2>&1
(cd $EX && VITE_AGENT_API=0 npx vite build --outDir dist-off --emptyOutDir --logLevel error) >/dev/null 2>&1
green "flag on: API in the build" $BR check-build $EX/dist enabled
green "flag off: API not in the build" $BR check-build $EX/dist-off disabled
red "control: flag off, expected on" "absent" $BR check-build $EX/dist-off enabled
red "control: flag on, expected off" "present" $BR check-build $EX/dist disabled
red "control: no build proves nothing" "no build" $BR check-build "$T/none" disabled

RUN="$BR run --base $BASE --out $T/runs"
serve dist
green "people-add, live backend, API recorded" $RUN $EX/scenarios/people-add.json --record-api "$T/api"
serve dist
green "navigation, hidden duplicate testid" $RUN $EX/scenarios/people-navigation.json
serve dist
red "control: server refusal named" "name_rejected" $RUN $EX/scenarios/_control-api-refusal.json
red "control: required label differs" "Current" $RUN $EX/scenarios/_control-label-required.json

# Replay: the server's memory is empty and a POST would change it; green must come from the file alone.
serve dist
green "replay from the recording" $RUN $EX/scenarios/people-add.json --replay-api "$T/api"
mkdir -p "$T/api-cut"
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('$T/api/people-add.json'));d.calls=d.calls.filter(c=>c.method==='GET');fs.writeFileSync('$T/api-cut/people-add.json',JSON.stringify(d))"
red "control: request missing from the recording" "POST /api/people" $RUN $EX/scenarios/people-add.json --replay-api "$T/api-cut"

# A renamed label the requirement does not quote stays green.
rm -f $EX/dist-renamed/assets/* 2>/dev/null
mkdir -p $EX/dist-renamed; cp -r $EX/dist/. $EX/dist-renamed/
sed -i 's/"Archive"/"Stored"/g' $EX/dist-renamed/assets/*.js
serve dist-renamed
if grep -q '"Stored"' $EX/dist-renamed/assets/*.js; then ok "label really renamed"; else fail "label not renamed"; fi
green "control: renamed label, scenario stays green" $RUN $EX/scenarios/people-navigation.json

serve dist
cd "$T"
green "session: start" $BR start --base "$BASE"
$BR step '{"goto": "/"}' > s1
if grep -q '"people.add"' s1; then ok "session: observed names the button"; else fail "observed"; cat s1; fi
if grep -q '"after"' s1; then ok "session: after taken from what was seen"; else fail "after not recorded"; fi
red "session: no such button" "people.nope" $BR step '{"click": {"testid": "people.nope"}, "after": {"state": "ready"}}'
red "session: after a failed action only goto" "goto" $BR step '{"click": {"testid": "people.add", "item": "Add person"}}'
green "session: goto lifts it" $BR step '{"goto": "/"}'
green "session: close" $BR close
cd "$ROOT"
echo; if [ "$FAILS" = 0 ]; then echo "ALL GREEN"; else echo "RED: $FAILS"; fi
exit "$FAILS"
