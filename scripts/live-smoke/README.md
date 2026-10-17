# Live-smoke harness for the native `/btw` popup

Local tooling used to check the installed popup against a real provider route with strict request bounds. It is **not part of the npm package** (`files` in `package.json` excludes `scripts/`) and is not run by `npm test` or CI.

## Verification status (read this first)
- Every test here was run **only against a fake Pi and a loopback fake provider** (plus fixtures that load the *installed* Pi 1.1.0 SDK against a loopback server with synthetic credentials). Nothing in this directory proves live behaviour by itself.
- The driver has run live exactly three times on 2026-10-16/17 (one summary run that produced no usable count, one ask run, one summary run). The summary and ask runs ended `HOLD` under the harness's own checks; the retained wire logs were re-analysed afterwards and passed. The seed-baseline cross-check added after the last summary run has **only been verified against the fake Pi**, not live.
- The first live run's request count is unknown (the observer was bypassed by Pi's `undici.install()`); this is fixed in `wire-observer.mjs` and regression-tested, but there is no retrospective bound.
- Run evidence (wire logs, panes, results) is deliberately not in this repository.

## Files
| File | Purpose |
|---|---|
| `live-smoke-driver-v4.mjs` | One bounded live run (`summary` or `ask`), or a fake run with `--fake`. Writes metadata-only receipts to `$BTW_SMOKE_OUT` (default: a temp dir). |
| `smoke-analysis.mjs` | Pure pass/fail analysis of the wire log, OAuth margin, retry-off and extension-isolation settings, child-session cross-check. |
| `wire-observer.mjs` | `NODE_OPTIONS=--import` preload: counts and **enforces** a request cap on `fetch` and `node:http(s)`; logs metadata only. |
| `heavy-overlap.mjs` | Refuses to start next to heavy local workloads. |
| `fake-pi.mjs`, `*.test.mjs` | Fake host/child and the test suites (`node --test <file>`). |
| `*-fixture.mjs`, `transport-child.mjs`, `compat-transport-child.mjs` | Local fixtures that need the installed Pi 1.1.0 and Claude Compat; tests skip when absent. |
| `summary-gate.sh`, `pins.sha256` | Read-only admission gate; pins the harness files. |
| `reanalyze-run.mjs` | Re-analyse a retained wire log without touching the original result. |
| `fixtures/` | Frozen earlier versions used as negative controls. |

## Running the tests (no model, no network)
```
cd scripts/live-smoke
for t in smoke-analysis wire-observer heavy-overlap retry-behavior summary-cap live-smoke-driver-v4; do node --test $t.test.mjs; done
```
The driver suite takes about two minutes and starts a real pseudo-terminal child. Run suites one at a time on a quiet machine.

## Running it live (needs an explicit owner approval and a free machine)
```
BTW_SMOKE_TRUSTED_ROOT=<canonical dir Pi already trusts> ./summary-gate.sh
BTW_SMOKE_TRUSTED_ROOT=<same> node live-smoke-driver-v4.mjs <6+ char stamp> <allocation id> summary
```
Cap, no-retry override and extension isolation are written into a throwaway project under the trusted root; the child still loads auto-discovered extensions (accepted limitation). Never reuse a consumed allocation or retry a failed run automatically.
