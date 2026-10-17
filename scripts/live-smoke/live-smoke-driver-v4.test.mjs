import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RETRY_OVERRIDE_SETTINGS } from './smoke-analysis.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-smoke-test-out-'));
process.on('exit', () => fs.rmSync(OUT_ROOT, { recursive: true, force: true }));
const DRIVER = path.join(HERE, 'live-smoke-driver-v4.mjs'), FAKEPI = path.join(HERE, 'fake-pi.mjs');
let n = 0;
async function server() {
  const seen = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.push({ url: req.url, body: b.length }); res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-status': 'allowed' }); res.end(JSON.stringify({ type: 'message', content: [], stop_reason: 'end_turn' })); }); });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { seen, base: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) };
}
function drive(scenario, variant, extra = [], driver = DRIVER) {
  const stamp = 'fk' + process.pid + '-' + (++n);
  return server().then(f => new Promise(resolve => {
    const p = spawn(process.execPath, [driver, stamp, 'FAKE-' + stamp, scenario, '--fake', '--fake-pi=' + FAKEPI, '--fake-base=' + f.base, '--fake-variant=' + variant, ...extra], { env: { PATH: process.env.PATH, HOME: process.env.HOME, BTW_SMOKE_OUT: OUT_ROOT } });
    let out = '', err = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c);
    let timedOut = false; const k = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 70000);
    p.on('close', async code => { clearTimeout(k); const dir = path.join(OUT_ROOT, 'run-' + stamp); const result = fs.existsSync(dir + '/result.json') ? JSON.parse(fs.readFileSync(dir + '/result.json', 'utf8')) : null; const raw = fs.existsSync(dir + '/wire.jsonl') ? fs.readFileSync(dir + '/wire.jsonl', 'utf8') : ''; await f.close(); resolve({ code, out, err, timedOut, result, seen: f.seen, dir, raw }); });
  }));
}
const cleanup = r => fs.rmSync(r.dir, { recursive: true, force: true });

test('summary scenario against the fake transport: COLLECTED, 3 claims across host/child/in-process, cap respected, clean exit', async () => {
  const r = await drive('summary', 'normal');
  try {
    assert.equal(r.timedOut, false, r.err); assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.result.status, 'COLLECTED', JSON.stringify(r.result.failures)); assert.equal(r.result.mode, 'FAKE');
    assert.deepEqual(r.result.receipt.roles, { host: 2, 'btw-child': 1 });
    assert.deepEqual(r.result.receipt.requests.map(x => x.max_tokens), [128000, 128000, 2048]);
    assert.equal(r.seen.length, 3); assert.deepEqual(r.result.groupLeft, []);
    assert.ok(r.result.unchanged.auth && r.result.unchanged.trust && r.result.unchanged.settings);
    assert.ok(!/synthetic|Bearer|authorization/i.test(JSON.stringify(r.result)), 'receipt must be metadata only');
  } finally { cleanup(r); }
});
test('missing summarizer request (the s3 situation) is HOLD, never a pass', async () => {
  const r = await drive('summary', 'nosummary');
  try { assert.equal(r.code, 1); assert.equal(r.result.status, 'HOLD'); assert.match(r.result.failures.join('|'), /expected exactly 3 claims, saw 2/); } finally { cleanup(r); }
});
test('summarizer without the 2048 wire cap is HOLD', async () => {
  const r = await drive('summary', 'bigsummary');
  try { assert.equal(r.code, 1); assert.match(r.result.failures.join('|'), /max_tokens<=2048, saw 0/); } finally { cleanup(r); }
});
test('extra requests past the cap are NOT SENT (server sees at most the cap) and the run is HOLD', async () => {
  const r = await drive('summary', 'extra');
  try {
    assert.equal(r.code, 1); assert.equal(r.result.status, 'HOLD');
    assert.ok(r.seen.length <= 3, 'server saw ' + r.seen.length); assert.match(r.result.failures.join('|'), /request bound hit/);
    assert.deepEqual(r.result.groupLeft, []);
  } finally { cleanup(r); }
});
test('OAuth traffic is flagged and fails the run', async () => {
  const r = await drive('summary', 'oauth');
  try { assert.equal(r.code, 1); assert.match(r.result.failures.join('|') + r.result.failure, /OAuth traffic/); } finally { cleanup(r); }
});
test('ask scenario: read-only tool set on the wire, in-process, 2 claims', async () => {
  const r = await drive('ask', 'normal');
  try {
    assert.equal(r.code, 0, r.out + r.err + JSON.stringify(r.result?.failures)); assert.equal(r.result.receipt.totalClaims, 2);
    assert.deepEqual(r.result.receipt.requests[0].toolNames.map(n => n.replace(/^_/, '')).filter(n => n !== '__pi_deferred_placeholder__').sort(), ['find', 'grep', 'ls', 'read']);
    assert.ok(r.result.receipt.requests[1].messages > r.result.receipt.requests[0].messages, 'tool round trip evidenced');
  } finally { cleanup(r); }
});
test('ask scenario with extra requests: bound blocks the 3rd (cap 2)', async () => {
  const r = await drive('ask', 'extra');
  try { assert.equal(r.code, 1); assert.ok(r.seen.length <= 2, 'server saw ' + r.seen.length); } finally { cleanup(r); }
});
test('refusals: live mode with a FAKE- id, fake mode with a real-looking id, unknown scenario, non-loopback base', async () => {
  const run = args => new Promise(resolve => { const p = spawn(process.execPath, [DRIVER, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, BTW_SMOKE_OUT: OUT_ROOT } }); let e = ''; p.stderr.on('data', c => e += c); p.on('close', code => resolve({ code, e })); });
  assert.match((await run(['refuse01', 'FAKE-x12345', 'summary'])).e, /FAKE- are for --fake runs only/);
  assert.match((await run(['refuse02', 'parent-alloc-1', 'summary', '--fake', '--fake-pi=x', '--fake-base=http://127.0.0.1:1'])).e, /FAKE- are for --fake runs only/);
  assert.match((await run(['refuse03', 'parent-alloc-1', 'nope'])).e, /scenario must be/);
  assert.match((await run(['refuse04', 'FAKE-abcdef', 'summary', '--fake', '--fake-pi=x', '--fake-base=http://example.com'])).e, /loopback/);
  assert.match((await run(['refuse05', '', 'summary'])).e, /parent allocation id is required/);
  for (const s of ['refuse01', 'refuse02', 'refuse03', 'refuse04', 'refuse05']) assert.ok(!fs.existsSync(path.join(OUT_ROOT, 'run-' + s)), 'refusal must not create a run dir');
});

test('NO-RETRY: the private override is written into the project before Pi starts, recorded in the receipt, and global settings stay unchanged', async () => {
  const r = await drive('summary', 'normal');
  try {
    assert.equal(r.result.status, 'COLLECTED', r.out + JSON.stringify(r.result.failures));
    assert.deepEqual(r.result.retryOverride.settings, RETRY_OVERRIDE_SETTINGS);
    assert.deepEqual(RETRY_OVERRIDE_SETTINGS, { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
    assert.ok(r.result.unchanged.settings && r.result.unchanged.auth && r.result.unchanged.trust);
  } finally { cleanup(r); }
});
test('NO-RETRY mutant: a driver that does not write the override makes the fake Pi refuse to start, so the run is HOLD', async () => {
  const mut = path.join(HERE, 'live-smoke-driver-v4.mutant-noretry.mjs');
  const src = fs.readFileSync(DRIVER, 'utf8');
  const lines = src.split('\n');
  const cut = lines.filter(l => !l.includes("PROJ+'/.pi"));
  assert.ok(cut.length < lines.length, 'mutant must actually remove the lines');
  fs.writeFileSync(mut, cut.join('\n'));
  let r;
  try { r = await drive('ask', 'normal', [], mut); assert.equal(r.result.status, 'HOLD'); assert.notEqual(r.code, 0); }
  finally { fs.rmSync(mut, { force: true }); if (r) cleanup(r); }
});

test('EXT-ISOLATION: host launched with -ne + explicit btw and guard, child package delta written, recorded in the receipt', async () => {
  const r = await drive('summary', 'normal');
  try {
    assert.equal(r.result.status, 'COLLECTED', r.out + JSON.stringify(r.result.failures));
    assert.deepEqual(r.result.extensionIsolation.hostArgs.slice(0, 1), ['-ne']);
    assert.deepEqual(r.result.extensionIsolation.childPackageDelta, ['https://github.com/fake/pkg-a']);
    assert.match(r.result.extensionIsolation.limit, /auto-discovered/);
  } finally { cleanup(r); }
});
test('EXT-ISOLATION mutant: a driver without -ne/-e makes the fake Pi refuse, so the run is HOLD', async () => {
  const mut = path.join(HERE, 'live-smoke-driver-v4.mutant-noext.mjs');
  const src = fs.readFileSync(DRIVER, 'utf8');
  assert.ok(src.includes('...HOST_EXT_ARGS'));
  fs.writeFileSync(mut, src.split('...HOST_EXT_ARGS,').join('').split(',...HOST_EXT_ARGS').join(''));
  let r;
  try { r = await drive('ask', 'normal', [], mut); assert.equal(r.result.status, 'HOLD'); assert.notEqual(r.code, 0); }
  finally { fs.rmSync(mut, { force: true }); if (r) cleanup(r); }
});

test('SEED BASELINE: contextual child file seeded with 1 inherited assistant reply + 1 side answer -> COLLECTED, counts preserved in the receipt', async () => {
  const r = await drive('summary', 'normal');
  try {
    assert.equal(r.result.status, 'COLLECTED', r.out + JSON.stringify(r.result.failures));
    const cs = r.result.receipt.childSession;
    assert.deepEqual(Object.values(cs.seedAssistantLines), [1]); assert.deepEqual(Object.values(cs.endAssistantLines), [2]); assert.equal(cs.assistantAddedAfterSeed, 1);
  } finally { cleanup(r); }
});
test('SEED BASELINE fails closed: no child session file at seed time -> HOLD with a proof-gap message, never a pass', async () => {
  const r = await drive('summary', 'noseedfile');
  try { assert.equal(r.result.status, 'HOLD'); assert.match(r.result.failures.join('|'), /proof gap/); assert.deepEqual(r.result.receipt.childSession.seedAssistantLines, {}); } finally { cleanup(r); }
});
test('SEED BASELINE mutant: the pre-fix predicate (count ALL assistant lines vs wire) reproduces the s6 false HOLD on the same fake', async () => {
  const mut = path.join(HERE, 'live-smoke-driver-v4.mutant-seed.mjs');
  const src = fs.readFileSync(DRIVER, 'utf8');
  const marker = 'const cc=childCrossCheck({seed:seedSnap,end:endSnap,wireChild:analysis.receipt.roles[\'btw-child\']||0});';
  assert.ok(src.includes(marker), 'marker present');
  fs.writeFileSync(mut, src.replace(marker, 'const cc=childCrossCheck({seed:Object.fromEntries(Object.keys(endSnap).map(k=>[k,0])),end:endSnap,wireChild:analysis.receipt.roles[\'btw-child\']||0});'));
  let r;
  try { r = await drive('summary', 'normal', [], mut); assert.equal(r.result.status, 'HOLD'); assert.match(r.result.failures.join('|'), /added after the seed 2/); }
  finally { fs.rmSync(mut, { force: true }); if (r) cleanup(r); }
});
