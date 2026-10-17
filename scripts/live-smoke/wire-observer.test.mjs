import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBS = path.join(HERE, 'wire-observer.mjs');
const PI_MODULES = path.join(process.env.HOME, '.pi/agent/install/releases/1.1.0/node_modules');
const SECRET_PROMPT = 'SECRET-PROMPT-TEXT-7f3a';
const SECRET_TOKEN = 'sk-ant-oat-SECRET-TOKEN-91c2';

async function fake() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen.push({ method: req.method, url: req.url });
      let wantsStream = false; try { wantsStream = JSON.parse(b).stream === true; } catch {}
      if (wantsStream) {
        const ev = (name, data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
        res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-5h-status': 'allowed' });
        res.end(ev('message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
          + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
          + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
          + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
          + ev('message_stop', { type: 'message_stop' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-status': 'allowed' });
      res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}
const WORLDS = [];
import { after } from 'node:test';
after(() => { for (const d of WORLDS) fs.rmSync(d, { recursive: true, force: true }); });
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-')); WORLDS.push(dir);
  const log = path.join(dir, 'wire.jsonl');
  return { dir, log, lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []), other: () => (fs.existsSync(log + '.other') ? fs.readFileSync(log + '.other', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const env = (w, extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '--import=' + OBS, SMOKE_WIRE_LOG: w.log, SMOKE_WIRE_CAP: '5', ...extra });
const run = (w, code, extra = {}) => new Promise(resolve => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: env(w, extra) }); let timedOut = false; const killer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 20000); p.on('close', () => clearTimeout(killer)); let out = '', err = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c); p.on('close', status => resolve({ status, out, err, timedOut })); });
const post = (base, body, extraInit = '') => `await fetch('${base}/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ${SECRET_TOKEN}', 'content-type': 'application/json' }, body: JSON.stringify(${body})${extraInit} })`;

test('logs metadata only: no prompt text, no header values, no tokens; keeps max_tokens, tool names, counts', async () => {
  const f = await fake(), w = world();
  try {
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 2048, stream: false, messages: [{ role: 'user', content: SECRET_PROMPT }], tools: [{ name: 'read' }, { name: 'ls' }] });
    const r = await run(w, post(f.base, body.replace(/\\/g, '') && body));
    assert.equal(r.timedOut, false); assert.equal(r.status, 0, r.err);
    const text = fs.readFileSync(w.log, 'utf8');
    assert.ok(!text.includes(SECRET_PROMPT) && !text.includes(SECRET_TOKEN) && !text.toLowerCase().includes('bearer'));
    const claim = w.lines().find(l => l.ev === 'claim');
    assert.deepEqual([claim.model, claim.max_tokens, claim.messages, claim.tools, claim.role, claim.api], ['claude-sonnet-5-5', 2048, 1, ['read', 'ls'], 'host', 'fetch']);
    const resp = w.lines().find(l => l.ev === 'response');
    assert.equal(resp.status, 200); assert.deepEqual(resp.headerNamesOnly, ['anthropic-ratelimit-unified-5h-status']);
    assert.equal(f.seen.length, 1);
  } finally { await f.close(); w.clean(); }
});

test('the bound is enforced: the 6th provider request is never sent', async () => {
  const f = await fake(), w = world();
  try {
    const code = `let blocked = 0; for (let i = 0; i < 7; i++) { try { await fetch('${f.base}/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [] }) }); } catch (e) { if (String(e.message).includes('bound exceeded')) blocked++; else throw e; } } console.log(blocked);`;
    const r = await run(w, code);
    assert.equal(r.status, 0, r.err); assert.equal(r.out.trim(), '2');
    assert.equal(f.seen.length, 5);
    assert.equal(w.lines().filter(l => l.ev === 'BLOCKED').length, 2);
  } finally { await f.close(); w.clean(); }
});

test('the bound is shared by child processes that inherit the environment, and children are labelled', async () => {
  const f = await fake(), w = world();
  try {
    const one = `await fetch('${f.base}/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [] }) })`;
    const parent = `import { spawnSync } from 'node:child_process';
      for (let i = 0; i < 3; i++) { ${one.replace(/\\\$/g, '')} }
      const c = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`let ok = 0, bl = 0; for (let i = 0; i < 4; i++) { try { await fetch('${f.base}/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [] }) }); ok++; } catch { bl++; } } console.log(ok + ',' + bl);`)}], { env: { ...process.env, PI_BTW_NATIVE_CONTROL: 'x' }, encoding: 'utf8' });
      console.log(c.stdout.trim());`;
    const r = await run(w, parent);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out.trim(), '2,2');                       // 3 host + 2 child allowed = 5; 2 child blocked
    assert.equal(f.seen.length, 5);
    const claims = w.lines().filter(l => l.ev === 'claim');
    assert.deepEqual([claims.filter(c => c.role === 'host').length, claims.filter(c => c.role === 'btw-child').length], [3, 4]);
  } finally { await f.close(); w.clean(); }
});

test('concurrent processes never exceed the bound', async () => {
  const f = await fake(), w = world();
  try {
    const code = `try { await fetch('${f.base}/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [] }) }); } catch {}`;
    await Promise.all(Array.from({ length: 12 }, () => run(w, code)));
    assert.ok(f.seen.length <= 5, 'server saw ' + f.seen.length);
    assert.equal(w.lines().filter(l => l.ev === 'claim').length, 12);
  } finally { await f.close(); w.clean(); }
});

test('non-provider traffic is not counted but its host is recorded', async () => {
  const f = await fake(), w = world();
  try {
    const code = `for (let i = 0; i < 9; i++) await fetch('${f.base}/health'); await fetch('${f.base}/mcp', { method: 'POST', body: '{}' });`;
    const r = await run(w, code);
    assert.equal(r.status, 0, r.err);
    assert.equal(w.lines().filter(l => l.ev === 'claim').length, 0);
    assert.equal(w.other().length, 10); assert.ok(w.other().every(o => o.host.startsWith('127.0.0.1')));
  } finally { await f.close(); w.clean(); }
});

test('Request objects and byte bodies are parsed; node http.request is counted and bounded too', async () => {
  const f = await fake(), w = world();
  try {
    const code = `
      await fetch(new Request('${f.base}/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'req', max_tokens: 7, messages: [1, 2] }) }));
      await fetch('${f.base}/v1/messages', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ model: 'bytes', max_tokens: 8, messages: [] })) });
      const http = await import('node:http'); let n = 0;
      for (let i = 0; i < 5; i++) { try { await new Promise((res, rej) => { const q = http.request('${f.base}/v1/messages', { method: 'POST' }, r => { r.resume(); r.on('end', res); }); q.on('error', rej); q.end('{}'); }); n++; } catch (e) { if (!String(e.message).includes('bound exceeded')) throw e; } }
      console.log(n);`;
    const r = await run(w, code);
    assert.equal(r.status, 0, r.err); assert.equal(r.out.trim(), '3');  // 2 fetch + 3 http = 5 allowed
    assert.equal(f.seen.length, 5);
    const c = w.lines().filter(l => l.ev === 'claim');
    assert.deepEqual(c.slice(0, 2).map(x => [x.model, x.max_tokens, x.messages]), [['req', 7, 2], ['bytes', 8, 0]]);
    assert.deepEqual(c.slice(2).map(x => x.api), ['node-http', 'node-http', 'node-http', 'node-http', 'node-http']);
  } finally { await f.close(); w.clean(); }
});

test('fails closed: an unwritable log blocks the provider request', async () => {
  const f = await fake(), w = world();
  try {
    const code = `try { await fetch('${f.base}/v1/messages', { method: 'POST', body: '{}' }); console.log('SENT'); } catch (e) { console.log('BLOCKED'); }`;
    const r = await run(w, code, { SMOKE_WIRE_LOG: path.join(w.dir, 'no-such-dir', 'wire.jsonl') });
    assert.equal(r.out.trim(), 'BLOCKED'); assert.equal(f.seen.length, 0);
  } finally { await f.close(); w.clean(); }
});

test('REAL SDK path: the Anthropic SDK pi uses is observed with its max_tokens, with no Pi extension involved', async () => {
  const f = await fake(), w = world();
  try {
    const code = `import { createRequire } from 'node:module'; const req = createRequire('${PI_MODULES}/'); const Anthropic = (await import(req.resolve('@anthropic-ai/sdk'))).default;
      const c = new Anthropic({ apiKey: 'x', baseURL: '${f.base}' }); const m = await c.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 2048, messages: [{ role: 'user', content: 'hi' }] }); console.log(m.stop_reason);`;
    const r = await run(w, code);
    assert.equal(r.status, 0, r.err); assert.equal(r.out.trim(), 'end_turn');
    const c = w.lines().find(l => l.ev === 'claim');
    assert.deepEqual([c.max_tokens, c.model, c.messages], [2048, 'claude-sonnet-5-5', 1]);
  } finally { await f.close(); w.clean(); }
});

test('REAL pi-ai Anthropic stream (the route claude-compat wraps) is observed through the preload', async () => {
  const f = await fake(), w = world();
  try {
    // SSE-less fake would fail the stream parse; the claim line is written before the response, which is all this test needs.
    const code = `import { createRequire } from 'node:module'; const req = createRequire('${PI_MODULES}/');
      const compat = await import('file://' + '${PI_MODULES}/@earendil-works/pi-ai/dist/compat.js');
      const model = { id: 'claude-sonnet-5-5', name: 'x', api: 'anthropic-messages', provider: 'anthropic', baseUrl: '${f.base}', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048 };
      const s = compat.streamSimpleAnthropic(model, { systemPrompt: 's', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }], tools: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }] }, { apiKey: 'x', maxTokens: 2048 });
      try { for await (const e of s) { if (e.type === 'done' || e.type === 'error') break; } } catch {}
      console.log('streamed');`;
    const r = await run(w, code);
    assert.equal(r.timedOut, false, 'child did not exit naturally (open handle or hung stream)');
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out.trim(), 'streamed');
    assert.equal(w.lines().filter(l => l.ev === 'response').length, 1);
    const c = w.lines().find(l => l.ev === 'claim');
    assert.ok(c, 'pi-ai stream request was not observed: ' + r.err.slice(0, 300));
    assert.equal(c.max_tokens, 2048); assert.equal(c.stream, true); assert.equal(c.model, 'claude-sonnet-5-5');
  } finally { await f.close(); w.clean(); }
});

test('OAuth refresh traffic is not a model request but is flagged AUTH-TRAFFIC', async () => {
  const f = await fake(), w = world();
  try {
    const r = await run(w, `await fetch('${f.base}/v1/oauth/token', { method: 'POST', body: '{}' });`);
    assert.equal(r.timedOut, false); assert.equal(r.status, 0, r.err);
    assert.equal(w.lines().filter(l => l.ev === 'claim').length, 0);
    assert.equal(w.lines().filter(l => l.ev === 'AUTH-TRAFFIC').length, 1);
  } finally { await f.close(); w.clean(); }
});

test('without the preload nothing is logged (negative control)', async () => {
  const f = await fake(), w = world();
  try {
    const r = await new Promise(resolve => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', `await fetch('${f.base}/v1/messages', { method: 'POST', body: '{}' })`], { env: { PATH: process.env.PATH, SMOKE_WIRE_LOG: w.log } });
      let timedOut = false; const killer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 20000);
      p.on('close', status => { clearTimeout(killer); resolve({ status, timedOut }); });
    });
    assert.equal(r.timedOut, false); assert.equal(r.status, 0); assert.equal(w.lines().length, 0); assert.equal(f.seen.length, 1);
  } finally { await f.close(); w.clean(); }
});

// ---- s4 regression: Pi 1.1.0 http-dispatcher.js runs undici.install() (plain globalThis.fetch = undici.fetch), which replaced the
// observer's fetch wrapper and made a REAL request invisible (live run s4a: pane showed an answer, wire log had 0 claims).
test('REGRESSION: a later plain assignment to globalThis.fetch (undici.install) does not remove the observer; the new fetch is still what runs', async () => {
  const w = world();
  const code = "let calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };"
    + "const r = await fetch('http://127.0.0.1:9/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }) });"
    + "if (calls !== 1 || r.status !== 200) { console.error('replacement fetch not used: ' + calls); process.exit(3); }";
  const r = await run(w, code);
  assert.equal(r.status, 0, r.err);
  assert.equal(w.lines().filter(l => l.ev === 'claim').length, 1, 'the replacement fetch must still be observed');
  assert.equal(w.lines().filter(l => l.ev === 'response').length, 1);
});
test('REGRESSION: an invalid SMOKE_WIRE_CAP fails closed (NaN would make "n > cap" false and disable the bound)', async () => {
  const f = await fake();
  try {
    for (const bad of ['abc', '0', '-1', '2.5']) {
      const w = world();
      const code = "try { await fetch('" + f.base + "/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }) }); process.exit(0); } catch { process.exit(7); }";
      const r = await run(w, code, { SMOKE_WIRE_CAP: bad });
      assert.equal(r.status, 7, 'cap ' + bad + ' must block, got ' + r.status);
    }
    assert.equal(f.seen.length, 0, 'no request may reach the server with an invalid cap');
  } finally { await f.close(); }
});
const HAVE_PI = fs.existsSync(path.join(PI_MODULES, '@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js'));
const child = (w, extra) => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(HERE, 'transport-child.mjs')], { env: { ...env(w, extra), PI_NODE_MODULES: PI_MODULES, NODE_OPTIONS: '--import=' + OBS + ' --max-old-space-size=192' } });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const k = setTimeout(() => p.kill('SIGKILL'), 20000); p.on('exit', () => { clearTimeout(k); const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { raw: out.slice(0, 300) }); });
});
test('ACTUAL TRANSPORT PATH: the real Pi http-dispatcher + installed pi-ai/anthropic SDK against a loopback fake with a synthetic key: counted with max_tokens and tool names', { skip: !HAVE_PI }, async () => {
  const w = world();
  const res = await child(w, { NREQ: '1', MAXTOK: '1500', TOOLS: 'find,grep,ls,read' });
  assert.equal(res.served, 1); assert.equal(res.fetchIsAccessor, true);
  const claims = w.lines().filter(l => l.ev === 'claim');
  assert.equal(claims.length, 1);
  assert.deepEqual([claims[0].max_tokens, claims[0].tools], [1500, ['find', 'grep', 'ls', 'read']]);
  assert.equal(w.lines().filter(l => l.ev === 'response').length, 1);
  assert.ok(!fs.readFileSync(w.log, 'utf8').includes('SYNTHETIC'), 'no key or body text in the log');
});
test('ACTUAL TRANSPORT PATH: the cap holds - with cap 2 the server sees 2 requests and the 3rd is blocked, not retried', { skip: !HAVE_PI }, async () => {
  const w = world();
  const res = await child(w, { NREQ: '3', SMOKE_WIRE_CAP: '2', TOOLS: 'read' });
  assert.equal(res.served, 2);
  assert.equal(w.lines().filter(l => l.ev === 'BLOCKED').length, 1);
  assert.equal(w.lines().filter(l => l.ev === 'claim').length, 3, 'blocked request must not be retried by the SDK or Pi (maxRetries 0)');
});
test('ACTUAL TRANSPORT PATH negative control: the pre-fix observer misses the same request', { skip: !HAVE_PI }, async () => {
  const w = world();
  const old = path.join(HERE, 'fixtures', 'wire-observer.pre-undici-fix.mjs');
  const res = await new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, 'transport-child.mjs')], { env: { ...env(w, { NREQ: '1' }), PI_NODE_MODULES: PI_MODULES, NODE_OPTIONS: '--import=' + old } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    const k = setTimeout(() => p.kill('SIGKILL'), 20000); p.on('exit', () => { clearTimeout(k); const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : {}); });
  });
  assert.equal(res.served, 1); assert.equal(w.lines().filter(l => l.ev === 'claim').length, 0);
});

const COMPAT_SRC = path.join(process.env.HOME, '.pi/agent/git/github.com/vazzma/pi-claude-request-compat/src');
const HAVE_COMPAT = HAVE_PI && fs.existsSync(path.join(COMPAT_SRC, 'extension.js'));
const compatChild = (w, extra, obs = OBS) => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(HERE, 'compat-transport-child.mjs')], { env: { ...env(w, extra), PI_NODE_MODULES: PI_MODULES, COMPAT_SRC, NODE_OPTIONS: '--import=' + obs + ' --max-old-space-size=192' } });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const k = setTimeout(() => p.kill('SIGKILL'), 20000); p.on('exit', () => { clearTimeout(k); const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { raw: out.slice(0, 300) }); });
});
test('REAL claude-compat strict wrapper + Pi dispatcher (loopback guard, synthetic token): request counted with api.anthropic.com host, max_tokens and renamed tools', { skip: !HAVE_COMPAT }, async () => {
  const w = world();
  const res = await compatChild(w, { NREQ: '1', TOOLS: 'find,grep,ls,read' });
  assert.equal(res.served, 1); assert.equal(res.guardBlocked, 0); assert.deepEqual(res.out, ['ok']);
  const claims = w.lines().filter(l => l.ev === 'claim');
  assert.equal(claims.length, 1); assert.equal(claims[0].host, 'api.anthropic.com'); assert.equal(claims[0].max_tokens, 1500);
  assert.deepEqual(claims[0].tools.map(n => n.replace(/^_/, '').toLowerCase()).sort(), ['find', 'grep', 'ls', 'read']);
  assert.ok(!fs.readFileSync(w.log, 'utf8').includes('SYNTHETIC'));
});
test('REAL claude-compat wrapper: cap 2 holds (server sees 2, 3rd blocked and not retried); pre-fix observer misses it', { skip: !HAVE_COMPAT }, async () => {
  const w = world();
  const res = await compatChild(w, { NREQ: '3', SMOKE_WIRE_CAP: '2', TOOLS: 'read' });
  assert.equal(res.served, 2); assert.equal(w.lines().filter(l => l.ev === 'BLOCKED').length, 1); assert.equal(w.lines().filter(l => l.ev === 'claim').length, 3);
  const w2 = world();
  const old = await compatChild(w2, { NREQ: '1' }, path.join(HERE, 'fixtures', 'wire-observer.pre-undici-fix.mjs'));
  assert.equal(old.served, 1); assert.equal(w2.lines().filter(l => l.ev === 'claim').length, 0, 'pre-fix observer is blind to the compat route');
});
