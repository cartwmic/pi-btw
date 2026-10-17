#!/bin/bash
# READ-ONLY admission gate to run BEFORE a live smoke. Starts nothing, writes nothing. Exit 0 only if every check passes.
# Env: BTW_SMOKE_TRUSTED_ROOT (required: the canonical directory Pi already trusts), NODE (optional), BTW_SMOKE_EXPECT_RECAP_SHA (optional).
cd "$(dirname "$0")" || exit 2
D=$PWD; REPO=$(cd ../.. && pwd)
N=${NODE:-$(command -v node)}
fail=0; chk(){ if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
[ -n "$BTW_SMOKE_TRUSTED_ROOT" ] || { echo "FAIL BTW_SMOKE_TRUSTED_ROOT is not set"; exit 2; }
echo "gate at $(date +%T)"
# 1. harness pins (pins.sha256 is regenerated with: shasum -a 256 <files> > pins.sha256 after a reviewed change)
if shasum -a 256 -c pins.sha256 >/dev/null 2>&1; then echo "PASS harness pins"; else echo "FAIL harness pins"; shasum -a 256 -c pins.sha256 2>&1 | grep -v ': OK'; fail=1; fi
chk seed-baseline-in-driver "$(grep -c 'childCrossCheck({seed:seedSnap' live-smoke-driver-v4.mjs)" 1
chk seed-baseline-in-analysis "$(grep -c 'export function childCrossCheck' smoke-analysis.mjs)" 1
chk summary-scenario "$(grep -o 'summary: { cap: 3, expectClaims: 3' smoke-analysis.mjs)" "summary: { cap: 3, expectClaims: 3"
# 2. the INSTALLED extension must be the one in this checkout
B=$HOME/.pi/agent/git/github.com/cartwmic/pi-btw/extensions
for f in btw.ts btw-native.ts btw-summary.ts; do chk "installed $f == checkout" "$(shasum -a 256 $B/$f | cut -c1-64)" "$(shasum -a 256 $REPO/extensions/$f | cut -c1-64)"; done
# 3. host state
chk auth-lock "$(ls $HOME/.pi/agent/auth.json.lock 2>/dev/null | wc -l | tr -d ' ')" 0
echo "INFO auth/trust/settings hashes (the driver re-pins and compares them before/after): $(shasum -a 256 $HOME/.pi/agent/auth.json $HOME/.pi/agent/trust.json $HOME/.pi/agent/settings.json 2>/dev/null | cut -c1-12 | tr '\n' ' ')"
if [ -n "$BTW_SMOKE_EXPECT_RECAP_SHA" ]; then chk recap-toggles "$(shasum -a 256 $HOME/.pi/agent/extensions/recap/config.json | cut -c1-16)" "$BTW_SMOKE_EXPECT_RECAP_SHA"; fi
chk recap-procs "$(pgrep -f session_recap | wc -l | tr -d ' ')" 0
chk leftovers "$(ls -d /tmp/btw-smoke-* /tmp/btw-fake-* /tmp/sumcap-* "$BTW_SMOKE_TRUSTED_ROOT"/_btw-live-smoke-* 2>/dev/null | wc -l | tr -d ' ')" 0
chk heavy "$(ps -axo command= | grep -E 'evalctl|pytest|vitest|/tsc |inspect-software-change|docker compose|cargo (build|test)|rustc|mut_driver|live-smoke|wire-observer' | grep -v grep | grep -v summary-gate | wc -l | tr -d ' ')" 0
p1=$(sysctl -n kern.memorystatus_vm_pressure_level); s1=$(vm_stat | awk '/Swapouts/{gsub("\\.","",$2);print $2}'); sleep 20
p2=$(sysctl -n kern.memorystatus_vm_pressure_level); s2=$(vm_stat | awk '/Swapouts/{gsub("\\.","",$2);print $2}')
chk pressure1 "$p1" 1; chk pressure2 "$p2" 1
if [ $((s2-s1)) -le 50 ]; then echo "PASS swapouts delta $((s2-s1)) (<=50) at $s2"; else echo "FAIL swapouts delta $((s2-s1)) at $s2"; fail=1; fi
# 4. credential freshness: reads only the expiry time, prints no secret
$N -e "const fs=require('fs'),os=require('os');const a=JSON.parse(fs.readFileSync(os.homedir()+'/.pi/agent/auth.json','utf8')).anthropic||{};const e=a.expires>1e12?a.expires/1000:a.expires;const m=Math.round((e-Date.now()/1000)/60);console.log((m>20?'PASS':'FAIL')+' oauth minutes left '+m+' (>20); type '+a.type);process.exit(m>20&&a.type==='oauth'?0:1)" || fail=1
echo "gate result: $([ $fail = 0 ] && echo ALL-PASS || echo NOT-ADMITTED)"; exit $fail
