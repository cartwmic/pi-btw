// Local regression for the summary wire cap (U1). Product code under test: installed claude-compat-guard + pinned Compat + Pi SDK/transport +
// btw-summary.ts boundedSummarize. Synthetic OAuth-shaped token, loopback-only fetch guard, no network, no credentials.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { analyze } from './smoke-analysis.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const HOME = process.env.HOME;
const PI = HOME + '/.pi/agent/install/releases/1.1.0/node_modules';
const HAVE = fs.existsSync(PI + '/@earendil-works/pi-coding-agent') && fs.existsSync(HOME + '/.pi/agent/extensions/claude-compat-guard/index.ts') && fs.existsSync(HOME + '/.pi/agent/models-store.json');
const run = (mode) => new Promise(resolve => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumcap-test-')); const log = dir + '/wire.jsonl';
  const p = spawn(process.execPath, ['summary-cap-fixture.mjs', mode], { cwd: HERE, env: { PATH: process.env.PATH, HOME, HOME_REAL: HOME, PI_NODE_MODULES: PI, COMPAT_SRC: HOME + '/.pi/agent/git/github.com/vazzma/pi-claude-request-compat/src', BTW_EXT: HOME + '/.pi/agent/git/github.com/cartwmic/pi-btw/extensions', SMOKE_WIRE_LOG: log, SMOKE_WIRE_CAP: '3', NODE_OPTIONS: '--import=' + HERE + '/wire-observer.mjs --experimental-transform-types --max-old-space-size=256' } });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const k = setTimeout(() => p.kill('SIGKILL'), 40000);
  p.on('exit', () => { clearTimeout(k); const m = /RESULT (.*)/.exec(out); const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; fs.rmSync(dir, { recursive: true, force: true }); resolve({ res: m ? JSON.parse(m[1]) : { raw: out.slice(-300) }, lines }); });
});
// the two non-summarizer requests of a real summary run, as synthetic wire records (host main answer + btw-child answer)
const others = (t0) => [
  { t: t0 + 1, pid: 1, ev: 'claim', role: 'host', api: 'fetch', model: 'claude-sonnet-5-5', max_tokens: 64000, stream: true, messages: 2, tools: ['_codemode'], toolCount: 1, parsed: true, bytes: 1 }, { t: t0 + 2, pid: 1, ev: 'response', n: 1, status: 200 },
  { t: t0 + 3, pid: 2, ev: 'claim', role: 'btw-child', api: 'fetch', model: 'claude-sonnet-5-5', max_tokens: 64000, stream: true, messages: 4, tools: ['_read'], toolCount: 1, parsed: true, bytes: 1 }, { t: t0 + 4, pid: 2, ev: 'response', n: 2, status: 200 },
];
test('SUMMARY CAP (U1) through guard + Compat + SDK session + real boundedSummarize: summarizer request is max_tokens 2048, no tools, one request, host role', { skip: !HAVE }, async () => {
  const { res, lines } = await run('capped');
  assert.equal(res.served, 1); assert.equal(res.blocked, 0); assert.equal(res.maxTokensSentByHelper, 2048); assert.ok(res.text, JSON.stringify(res));
  const claims = lines.filter(l => l.ev === 'claim'); assert.equal(claims.length, 1);
  assert.equal(claims[0].max_tokens, 2048); assert.deepEqual(claims[0].tools, []); assert.equal(claims[0].role, 'host'); assert.equal(claims[0].host, 'api.anthropic.com');
  const all = [...others(claims[0].t - 10), ...lines.map(l => ({ ...l, t: l.t, pid: 1 }))];
  const a = analyze('summary', all.sort((x, y) => x.t - y.t)); assert.deepEqual(a.failures, []); assert.equal(a.ok, true);
});
test('SUMMARY CAP control: without the cap on the model copy the wire shows 64000 and the analyzer fails (the check discriminates)', { skip: !HAVE }, async () => {
  const { res, lines } = await run('uncapped');
  assert.equal(res.served, 1); const claims = lines.filter(l => l.ev === 'claim'); assert.equal(claims[0].max_tokens, 64000);
  const a = analyze('summary', [...others(claims[0].t - 10), ...lines].sort((x, y) => x.t - y.t)); assert.equal(a.ok, false);
  assert.match(a.failures.join('|'), /max_tokens<=2048/);
});
