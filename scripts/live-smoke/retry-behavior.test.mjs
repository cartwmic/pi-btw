// Real installed `pi` CLI (print mode) in a temp agent dir against a LOOPBACK server that always fails; SYNTHETIC key; no real network/credentials.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_BIN = path.join(process.env.HOME, '.pi/agent/bin/pi'); const HAVE = fs.existsSync(PI_BIN);
const run = (mode, status, extra = {}) => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(HERE, 'retry-fixture.mjs'), mode, String(status)], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_BIN, OBS: path.join(HERE, 'wire-observer.mjs'), ...extra } });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const k = setTimeout(() => p.kill('SIGKILL'), 80000); p.on('exit', () => { clearTimeout(k); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ raw: out.slice(-300) }); } });
});
test('CONTROL: default Pi settings retry a failing provider (1 + 3 agent retries = 4 POSTs), and the observer counts every one', { skip: !HAVE }, async () => {
  const r = await run('control-fast', 529); assert.equal(r.posts, 4); assert.equal(r.claims, 4); assert.equal(r.blocked, 0);
});
test('NO-RETRY OVERRIDE through the real pi launch path: exactly 1 POST for 529, 500 and 429, observer claims == server POSTs', { skip: !HAVE }, async () => {
  for (const s of [529, 500, 429]) { const r = await run('override', s); assert.equal(r.posts, 1, 'status ' + s + ' ' + JSON.stringify(r)); assert.equal(r.claims, 1); }
});
test('CAP through the real pi launch path: with cap 2 the server sees at most 2 even while Pi keeps retrying', { skip: !HAVE }, async () => {
  const r = await run('control-fast', 529, { CAP: '2' }); assert.equal(r.posts, 2); assert.ok(r.blocked >= 1);
});
test('NEGATIVE CONTROL: the pre-fix observer sees none of the real CLI requests', { skip: !HAVE }, async () => {
  const r = await run('control-fast', 529, { OBS: path.join(HERE, 'fixtures', 'wire-observer.pre-undici-fix.mjs') }); assert.equal(r.posts, 4); assert.equal(r.claims, 0);
});
