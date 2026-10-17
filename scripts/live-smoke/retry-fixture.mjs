// Local-only: the REAL installed `pi` CLI (print mode) against a LOOPBACK fake that fails every request, with a SYNTHETIC key,
// in a temp HOME / PI_CODING_AGENT_DIR (real auth.json/settings.json never read). Counts requests at the server, independent of any observer.
// usage: node retry-fixture.mjs <mode: default|control-fast|override> [status=529]
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { RETRY_OVERRIDE_SETTINGS } from './smoke-analysis.mjs';
const mode = process.argv[2] || 'default', STATUS = Number(process.argv[3] || 529);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retryfx-'))); const home = root + '/home', agent = root + '/agent', proj = root + '/proj';
for (const d of [home, agent, proj]) fs.mkdirSync(d, { recursive: true });
let posts = 0, gets = 0;
const server = http.createServer((req, res) => { req.resume(); req.on('end', () => {
  if (req.method === 'POST') posts++; else gets++;
  res.writeHead(STATUS, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'synthetic' } })); }); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
fs.writeFileSync(agent + '/models.json', JSON.stringify({ providers: { fakeant: { baseUrl: base, api: 'anthropic-messages', apiKey: 'sk-ant-api03-SYNTHETIC', models: [{ id: 'claude-sonnet-5-5', name: 'synthetic', contextWindow: 200000, maxTokens: 8192 }] } } }));
fs.writeFileSync(agent + '/settings.json', JSON.stringify({ enableInstallTelemetry: false, cacheWarming: 'off', ...(mode === 'control-fast' ? { retry: { baseDelayMs: 50 } } : {}) }));
fs.writeFileSync(agent + '/trust.json', JSON.stringify({ [root]: true }));
if (mode === 'override') { fs.mkdirSync(proj + '/.pi'); fs.writeFileSync(proj + '/.pi/settings.json', JSON.stringify(RETRY_OVERRIDE_SETTINGS)); }
if (mode === 'control-fast') { /* global baseDelay only, retries default */ }
const WIRE = root + '/wire.jsonl';
const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', ...(process.env.OBS ? { NODE_OPTIONS: '--import=' + process.env.OBS, SMOKE_WIRE_LOG: WIRE, SMOKE_WIRE_CAP: process.env.CAP || '5' } : {}) };
const pi = process.env.PI_BIN;
const t0 = Date.now();
const p = spawn(pi, ['--print', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--model', 'fakeant/claude-sonnet-5-5', 'say hi'], { cwd: proj, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
const kill = setTimeout(() => { out += '[fixture-timeout]'; p.kill('SIGKILL'); }, 90000);
await new Promise(r => p.on('exit', r)); clearTimeout(kill);
await new Promise(r => setTimeout(r, 1500)); // let any late retry arrive
const lines = fs.existsSync(WIRE) ? fs.readFileSync(WIRE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
console.log(JSON.stringify({ mode, status: STATUS, posts, gets, claims: lines.filter(l => l.ev === 'claim').length, blocked: lines.filter(l => l.ev === 'BLOCKED').length, ms: Date.now() - t0, tail: out.replace(/\s+/g, ' ').slice(-160) }));
server.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
