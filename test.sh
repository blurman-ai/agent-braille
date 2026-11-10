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
red()   { # red <title> <required text> <command…>; the text must come from the failure, not from the scenario's name or steps
  local title=$1 wanted=$2; shift 2
  rm -rf "$T/runs"
  if "$@" >"$T/o" 2>&1; then fail "$title: went green"; cat "$T/o"; return; fi
  sed -E 's/^RED +[^ ]+//; s/ :: [^ ]*$//' "$T/o" > "$T/why"
  find "$T/runs" -name report.json -exec cat {} + >> "$T/why" 2>/dev/null
  if grep -q -- "$wanted" "$T/why"; then ok "$title"; else fail "$title: no «$wanted»"; cat "$T/o"; fi; }

browser_starts() { node --input-type=module -e 'import { chromium } from "playwright-core"; import { chromeOption } from "./lib/browser.mjs"; const b = await chromium.launch({ ...chromeOption(process.env), args: ["--no-sandbox"] }); await b.close();' >/dev/null 2>&1; }
if ! browser_starts; then echo "No browser: run npx playwright-core install chromium, or set BRAILLE_CHROME=/path/to/chrome"; exit 2; fi

green "executor and CLI control cases" $BR selftest
green "runtime tests" npx vitest run
green "scenario form" $BR check $EX/scenarios
printf '{"name":"x","why":"y","verifies":["z"],"steps":[{"goto":"/"},{"wait":"t"}]}' > "$T/x.json"
red "control: bad scenario refused" "needs after" $BR run "$T/x.json" --base "$BASE"

[ -d $EX/node_modules ] || (cd $EX && npm install --no-audit --no-fund --silent)
green "install runtime" $BR install $EX
rm -f $EX/src/shared/stalker/*.test.ts
echo "// drift" >> $EX/src/shared/stalker/busy.ts
red "control: drifted copy reported" "differs" $BR check-runtime $EX
green "install restores it" $BR install $EX
rm -f $EX/src/shared/stalker/*.test.ts
mkdir -p $EX/src/shared/agent && cp $EX/src/shared/stalker/busy.ts $EX/src/shared/agent/busy.ts
red "control: copy from before window.stalker reported" "old copy" $BR check-runtime $EX
green "install removes the old copy" $BR install $EX
[ ! -e $EX/src/shared/agent ] || fail "install left src/shared/agent"
rm -f $EX/src/shared/stalker/*.test.ts
(cd $EX && VITE_STALKER=1 npx vite build --outDir dist --emptyOutDir --logLevel error) >/dev/null 2>&1
(cd $EX && VITE_STALKER=0 npx vite build --outDir dist-off --emptyOutDir --logLevel error) >/dev/null 2>&1
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
started=$SECONDS
red "control: a failed request ends the wait, named" "name_rejected" $RUN $EX/scenarios/_control-api-wait.json
if [ $((SECONDS - started)) -lt 15 ]; then ok "control: the wait ended within 15 s"; else fail "control: the wait took $((SECONDS - started)) s"; fi
started=$SECONDS
red "control: a request failed a step earlier ends the wait, named" "name_rejected" $RUN $EX/scenarios/_control-api-earlier.json
if [ $((SECONDS - started)) -lt 15 ]; then ok "control: that wait ended within 15 s"; else fail "control: that wait took $((SECONDS - started)) s"; fi
red "control: browser missing is named" "the browser did not start" env BRAILLE_CHROME=/nonexistent $RUN $EX/scenarios/_control-label-required.json
red "control: required label differs" "Current" $RUN $EX/scenarios/_control-label-required.json

serve dist
red "control: covered button, real browser, cover named" "is covered: .*open dialog: \"New person\"" $RUN $EX/scenarios/_control-covered-button.json

# Replay: the server's memory is empty and a POST would change it; green must come from the file alone.
serve dist
green "replay from the recording" $RUN $EX/scenarios/people-add.json --replay-api "$T/api"
mkdir -p "$T/api-cut"
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('$T/api/people-add.json'));d.calls=d.calls.filter(c=>c.method==='GET');fs.writeFileSync('$T/api-cut/people-add.json',JSON.stringify(d))"
red "control: request missing from the recording" "POST /api/people" $RUN $EX/scenarios/people-add.json --replay-api "$T/api-cut"

serve dist
$BR mutate $EX/scenarios/people-add.json --base "$BASE" --replay-api "$T/api" --out "$T/mutate" > "$T/m" 2>&1
if grep -q '^caught     500 POST /api/people' "$T/m"; then ok "mutate: a broken save is caught"; else fail "mutate: save"; cat "$T/m"; fi
mkdir -p "$T/weak-dir"; python3 -c "
import json;d=json.load(open('$EX/scenarios/people-add.json'));d['name']='weak';d['steps']=d['steps'][:1]+[{'wait':'People'}]
json.dump(d,open('$T/weak.json','w'))
r=json.load(open('$T/api/people-add.json'));r['scenario']='weak';json.dump(r,open('$T/weak-dir/weak.json','w'))"
serve dist
if $BR mutate "$T/weak.json" --base "$BASE" --replay-api "$T/weak-dir" --out "$T/mutate2" --strict > "$T/m2" 2>&1; then fail "mutate: a weak scenario passed strict"; cat "$T/m2"; elif grep -q 'NOT CAUGHT 500 POST /api/people' "$T/m2"; then ok "control: mutate reports a scenario that never saves"; else fail "control: mutate"; cat "$T/m2"; fi

# The data layer: a refusal the page tells about is not a sensor finding; the same refusal with the alert gone is.
serve dist
$RUN $EX/scenarios/_control-api-refusal.json --sensors > "$T/o" 2>&1
if grep -q "said nothing" "$T/o" $(find "$T/runs" -name report.json 2>/dev/null); then fail "sensors: a told refusal reported as silent"; cat "$T/o"; else ok "sensors: a told refusal is not a finding"; fi
green "sensors: people-add stays green" $RUN $EX/scenarios/people-add.json --sensors
rm -rf $EX/dist-silent; cp -r $EX/dist $EX/dist-silent
sed -i 's/role:"alert"/role:"note"/g' $EX/dist-silent/assets/*.js
if grep -q 'role:"note"' $EX/dist-silent/assets/*.js; then ok "alert really removed"; else fail "alert not removed"; fi
serve dist-silent
red "control: sensors name a silent refused save" "POST /api/people -> 422) and the page said nothing" $RUN $EX/scenarios/_control-api-refusal.json --sensors

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
if grep -q 'GET /api/people 200' s1; then ok "session: the answer names the step's requests"; else fail "no api in the answer"; cat s1; fi
if grep -q '"text"' s1 && grep -q 'People' s1; then ok "session: the answer holds the visible text"; else fail "no text in the answer"; cat s1; fi
if grep -q '"after"' s1; then ok "session: after taken from what was seen"; else fail "after not recorded"; fi
red "session: no such button" "people.nope" $BR step '{"click": {"testid": "people.nope"}, "after": {"state": "ready"}}'
green "session: a click that did not land keeps the session" $BR step '{"click": {"testid": "people.add", "item": "Add person"}}'
red "session: after that did not come true, only goto" "goto" sh -c "$BR step '{\"press\": \"Escape\", \"after\": {\"shown\": [\"people.nope\"], \"within\": 1}}'; $BR step '{\"press\": \"Escape\"}'"
green "session: goto lifts it" $BR step '{"goto": "/"}'
$BR step '{"goto": "/"}' >/dev/null; $BR step '{"click": {"testid": "people.add", "item": "Add person"}}' >/dev/null; $BR step '{"fill": {"label": "Name"}, "value": "boom"}' >/dev/null; $BR step '{"click": {"testid": "people.role"}}' >/dev/null; $BR step '{"click": {"role": "option", "name": "Designer"}}' >/dev/null
$BR step '{"click": {"testid": "people.save"}}' > s2
if grep -q '"notices"' s2 && grep -q 'Not saved' s2; then ok "session: an alert is in notices"; else fail "no notices"; cat s2; fi
if grep -q '"contradictions"' s2 && grep -q 'POST /api/people 422' s2; then ok "session: ready with a failed request is a contradiction"; else fail "no contradiction"; cat s2; fi
$BR step '{"goto": "/"}' >/dev/null; $BR step '{"click": {"testid": "people.add", "item": "Add person"}}' >/dev/null
started=$SECONDS; $BR step '{"fill": "Role", "value": "Engineer"}' > s3
if grep -q 'is a list' s3 && [ $((SECONDS - started)) -lt 5 ]; then ok "session: a list refuses typing at once"; else fail "a list"; cat s3; fi
green "session: close" $BR close
cd "$ROOT"
echo; if [ "$FAILS" = 0 ]; then echo "ALL GREEN"; else echo "RED: $FAILS"; fi
exit "$FAILS"
