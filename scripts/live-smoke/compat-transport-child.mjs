// Local-only: the REAL installed claude-compat strict stream wrapper + real Pi http-dispatcher (undici.install) + real pi-ai Anthropic stream.
// SYNTHETIC token only. The bottom fetch layer is a guard that forwards ONLY to a loopback fake and throws for anything else, so no
// byte can leave the machine. Never reads auth.json; profile lookup is pointed at an empty temp agent dir. Metadata only.
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PI = process.env.PI_NODE_MODULES, COMPAT = process.env.COMPAT_SRC, NREQ = Number(process.env.NREQ || 1);
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-agent-'));
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY']) delete process.env[k];
let served = 0, bytes = [];
const server = http.createServer((req, res) => {
  let n = 0; req.on('data', c => n += c.length);
  req.on('end', () => {
    if (req.method === 'POST' && /\/v1\/messages/.test(req.url)) { served++; bytes.push(n); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' });
    const ev = (e, d) => res.write('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n');
    ev('message_start', { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
    ev('content_block_stop', { type: 'content_block_stop', index: 0 });
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
    ev('message_stop', { type: 'message_stop' }); res.end();
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const undici = await import(PI + '/undici/index.js');
const { configureHttpDispatcher } = await import(PI + '/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js');
configureHttpDispatcher(60000); // Pi startup: undici.install() replaces globalThis.fetch
let guardHits = 0, guardBlocked = 0;
const guard = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.hostname !== 'api.anthropic.com' && u.hostname !== '127.0.0.1') { guardBlocked++; throw new Error('guard: refusing non-loopback host'); }
  guardHits++; return undici.fetch('http://127.0.0.1:' + port + u.pathname + u.search, { ...init, redirect: 'manual' });
};
globalThis.fetch = guard; // with the observer this goes through the accessor setter; without it, this REPLACES the fetch like undici.install did
const { createFallbackStream } = await import(COMPAT + '/extension.js');
const compat = await import(PI + '/@earendil-works/pi-ai/dist/compat.js');
const { normalizeContext } = await import(PI + '/@earendil-works/pi-ai/dist/utils/transcript.js');
const stream = createFallbackStream(compat.streamSimpleAnthropic, compat.createAssistantMessageEventStream, { strict: true });
const model = { id: 'claude-sonnet-5-5', name: 'synthetic', api: 'claude-compat-messages', provider: 'claude-compat', baseUrl: 'https://api.anthropic.com', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const tl = (process.env.TOOLS || '').split(',').filter(Boolean).map(name => ({ name, description: 'synthetic', parameters: { type: 'object', properties: {} } }));
const out = [];
for (let i = 0; i < NREQ; i++) {
  try {
    const s = stream(model, normalizeContext({ systemPrompt: 'synthetic', messages: [{ role: 'user', content: 'synthetic', timestamp: Date.now() }], tools: tl }), { apiKey: 'sk-ant-oat01-SYNTHETIC-NOT-REAL', maxTokens: 1500 });
    for await (const e of s) {} const r = await s.result();
    out.push(r.stopReason === 'error' ? 'error:' + String(r.errorMessage).slice(0, 110) : 'ok');
  } catch (e) { out.push('threw:' + String(e.message).slice(0, 110)); }
}
console.log('RESULT ' + JSON.stringify({ served, bytes, out, guardHits, guardBlocked, fetchIsAccessor: !!Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.get }));
server.close(); fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true }); process.exit(0);
