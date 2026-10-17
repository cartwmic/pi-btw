// Local-only: REAL installed btw-summary.ts boundedSummarize + REAL pi-coding-agent createAgentSession + REAL pi-ai stream + REAL claude-compat
// provider config (obtained by running the installed extension's default export against a capture-only pi stub) + Pi's real http-dispatcher.
// SYNTHETIC OAuth-shaped token; the bottom fetch is a loopback-only guard (refuses any other host). Never reads auth.json. Metadata only.
// usage: node --experimental-transform-types summary-cap-fixture.mjs <capped|uncapped>
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const PI = process.env.PI_NODE_MODULES, COMPAT = process.env.COMPAT_SRC, BTW = process.env.BTW_EXT;
const mode = process.argv[2] || 'capped';
const agent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sumcap-'))); process.env.PI_CODING_AGENT_DIR = agent;
const REAL = process.env.HOME_REAL + '/.pi/agent';
const synth = { type: 'oauth', access: 'sk-ant-oat01-SYNTHETIC-NOT-REAL', refresh: 'sk-ant-ort01-SYNTHETIC-NOT-REAL', expires: Date.now() + 6 * 3600e3 };
fs.writeFileSync(agent + '/auth.json', JSON.stringify({ anthropic: synth }), { mode: 0o600 });
fs.copyFileSync(REAL + '/models-store.json', agent + '/models-store.json'); // model catalog only (no credentials)
fs.mkdirSync(agent + '/git/github.com', { recursive: true }); fs.symlinkSync(REAL + '/git/github.com/vazzma', agent + '/git/github.com/vazzma'); // pinned compat package, read-only
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY']) delete process.env[k];
let served = 0; const server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
  if (req.method === 'POST' && /\/v1\/messages/.test(req.url)) served++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (e, d) => res.write('event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n');
  ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A short synthetic summary.' } });
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' }); res.end(); }); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const undici = await import(PI + '/undici/index.js');
const { configureHttpDispatcher } = await import(PI + '/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js');
configureHttpDispatcher(60000);
let blocked = 0;
globalThis.fetch = async (input, init) => { const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.hostname !== 'api.anthropic.com' && u.hostname !== '127.0.0.1') { blocked++; throw new Error('guard: refusing non-loopback host'); }
  return undici.fetch('http://127.0.0.1:' + port + u.pathname + u.search, { ...init, redirect: 'manual' }); };
// load the PRODUCT claude-compat-guard (which wraps compat with the shared Anthropic auth) against a capture-only pi stub
const gdir = agent + '/guardcopy'; fs.mkdirSync(gdir);
const GSRC = process.env.HOME_REAL + '/.pi/agent/extensions/claude-compat-guard';
for (const f of ['guard.mjs', 'load.mjs', 'shared-auth.mjs']) fs.copyFileSync(GSRC + '/' + f, gdir + '/' + f);
const piUrl = 'file://' + PI + '/@earendil-works/pi-coding-agent/dist/index.js', aiUrl = 'file://' + PI + '/@earendil-works/pi-ai/dist/index.js';
fs.writeFileSync(gdir + '/index.ts', fs.readFileSync(GSRC + '/index.ts', 'utf8').replace('"@earendil-works/pi-coding-agent"', JSON.stringify(piUrl)).replace('"@earendil-works/pi-ai"', JSON.stringify(aiUrl)));
const captured = {}; const stub = { registerProvider: (c) => { captured.cfg = c; }, on() {}, registerCommand() {}, events: { on() {}, emit() {} } };
await (await import(gdir + '/index.ts')).default(stub);
const sdk = await import(PI + '/@earendil-works/pi-coding-agent/dist/index.js');
const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false }); // reads agentDir auth.json + models-store.json like the product
modelRuntime.registerNativeProvider(captured.cfg); await modelRuntime.refresh({ allowNetwork: false });
// The copied catalog has no claude-sonnet-5-5 entry under claude-compat; derive a SYNTHETIC sonnet-id model from a real catalog entry with the
// 64000 output limit the live route showed. This exercises the same summarizer/stream/compat code; only the model record is synthetic.
const base = modelRuntime.getModel('claude-compat', 'claude-sonnet-5-5') ?? modelRuntime.getModels('claude-compat').find(m => /claude-(opus|fable|sonnet)/.test(m.id));
if (!base) { console.log('RESULT ' + JSON.stringify({ error: 'no claude-compat model in catalog copy' })); process.exit(2); }
const model = { ...base, id: 'claude-sonnet-5-5', name: 'synthetic sonnet', maxTokens: 64000 };
const { boundedSummarize, DEFAULT_SUMMARY_LIMITS } = await import(BTW + '/btw-summary.ts');
const proj = path.join(agent, 'proj'); fs.mkdirSync(proj);
const loader = new sdk.DefaultResourceLoader({ cwd: proj, agentDir: agent, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => 'Summarize synthetic text.' });
await loader.reload();
const lastText = (s) => { const m = [...s.messages].reverse().find(x => x.role === 'assistant'); return m ? { stopReason: m.stopReason, errorMessage: m.errorMessage, text: (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), usage: m.usage, model: m.model } : undefined; };
const open = async (capped) => { const { session } = await sdk.createAgentSession({ cwd: proj, agentDir: agent, sessionManager: sdk.SessionManager.inMemory(), model: mode === 'uncapped' ? model : capped, modelRuntime, thinkingLevel: 'off', tools: [], resourceLoader: loader });
  return { prompt: (t) => session.prompt(t, { source: 'extension' }), abort: () => session.abort(), dispose: () => session.dispose(), lastAssistant: () => lastText(session) }; };
let outcome; try { outcome = await boundedSummarize({ open, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t) }, model, 'synthetic thread text', DEFAULT_SUMMARY_LIMITS); } catch (e) { outcome = { error: String(e.message).slice(0, 120) }; }
console.log('RESULT ' + JSON.stringify({ mode, served, blocked, maxTokensSentByHelper: outcome.maxTokensSent, error: outcome.error, text: outcome.text && outcome.text.slice(0, 30) }));
server.close(); fs.rmSync(agent, { recursive: true, force: true }); process.exit(0);
