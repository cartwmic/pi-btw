// Local-only transport fixture: REAL installed Pi http-dispatcher (undici.install) + REAL installed pi-ai/@anthropic-ai/sdk path
// against a LOOPBACK fake Anthropic endpoint with a SYNTHETIC key. Never reads auth.json; never contacts any real host.
// Metadata only: the fake server counts requests and records byte sizes, never bodies.
import http from 'node:http';
const PI = process.env.PI_NODE_MODULES; // installed Pi release node_modules (read-only import)
const NREQ = Number(process.env.NREQ || 1), MAXTOK = Number(process.env.MAXTOK || 1500);
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
let served = 0; const sizes = [];
const server = http.createServer((req, res) => {
  let n = 0; req.on('data', c => { n += c.length; });
  req.on('end', () => {
    if (req.method === 'POST' && /\/v1\/messages/.test(req.url)) { served++; sizes.push(n); }
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
const base = 'http://127.0.0.1:' + server.address().port;
const { configureHttpDispatcher } = await import(PI + '/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js');
if (process.env.NO_DISPATCHER !== '1') configureHttpDispatcher(60000); // what Pi runs at startup (undici.install())
const { streamSimpleAnthropic } = await import(PI + '/@earendil-works/pi-ai/dist/compat.js');
const { normalizeContext } = await import(PI + '/@earendil-works/pi-ai/dist/utils/transcript.js'); // provider fns expect the normalized transcript (system prompt/tools folded in)
const model = { id: 'claude-sonnet-5-5', name: 'synthetic', api: 'anthropic-messages', provider: 'anthropic', baseUrl: base, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
const tools = (process.env.TOOLS || '').split(',').filter(Boolean).map(name => ({ name, description: 'synthetic', parameters: { type: 'object', properties: {} } }));
const out = [];
for (let i = 0; i < NREQ; i++) {
  try {
    const s = streamSimpleAnthropic(model, normalizeContext({ systemPrompt: 'synthetic', messages: [{ role: 'user', content: 'synthetic', timestamp: Date.now() }], tools }), { apiKey: 'sk-ant-api03-SYNTHETIC-NOT-A-REAL-KEY', maxTokens: MAXTOK });
    let last; for await (const e of s) last = e; const r = await s.result();
    out.push(r.stopReason === 'error' ? 'error:' + String(r.errorMessage).slice(0, 80) : 'ok');
  } catch (e) { out.push('threw:' + String(e.message).slice(0, 80)); }
}
console.log('RESULT ' + JSON.stringify({ served, sizes, out, fetchIsAccessor: !!Object.getOwnPropertyDescriptor(globalThis, 'fetch')?.get }));
server.close(); process.exit(0);
