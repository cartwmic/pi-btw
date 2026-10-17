// FAKE Pi for driver tests only: speaks just enough terminal protocol for the driver and makes provider requests through fetch,
// from the host process, from a real child process (PI_BTW_NATIVE_CONTROL set) and in-process (summarizer / ask). Never talks to a real provider.
import { spawn } from 'node:child_process';
const BASE = process.env.FAKE_BASE, VARIANT = process.env.FAKE_VARIANT || 'normal';
const call = async (max_tokens, tools, nmsg = 1) => {
  try {
    const res = await fetch(BASE + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens, stream: false, messages: Array.from({ length: nmsg }, () => ({ role: 'user', content: 'synthetic' })), tools: tools.map(name => ({ name })) }) });
    return res.status;
  } catch (e) { return 'ERR ' + String(e.message).slice(0, 60); }
};
if (process.argv[2] === '--child') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async d => { if (d.includes('ASK')) { const s = await call(128000, ['read', 'grep', 'find', 'ls']); process.stdout.write('CHILD-DONE ' + s + '\n'); } if (d.includes('BYE')) process.exit(0); });
} else {
  const say = s => process.stdout.write(s + '\r\n');
  // The driver must have written the private no-retry override into the project (cwd) BEFORE launching Pi.
  try { const o = JSON.parse((await import('node:fs')).readFileSync(process.cwd() + '/.pi/settings.json', 'utf8')); if (!(o.retry && o.retry.enabled === false && o.retry.maxRetries === 0 && o.retry.provider && o.retry.provider.maxRetries === 0)) throw 0; }
  catch { say('NO-RETRY-OVERRIDE-MISSING'); process.exit(9); }
  // The driver must launch the host with -ne plus exactly the two explicit extensions, and write the child package delta.
  { const a = process.argv.slice(2); const ok = a[0] === '-ne' && a.filter(x => x === '-e').length === 2 && /pi-btw\/extensions\/btw\.ts$/.test(a[2] || '') && /claude-compat-guard\/index\.ts$/.test(a[4] || '');
    let pk = []; try { pk = JSON.parse((await import('node:fs')).readFileSync(process.cwd() + '/.pi/settings.json', 'utf8')).packages || []; } catch {}
    if (!ok || !pk.length || pk.some(p => p.autoload !== false || JSON.stringify(p.extensions) !== '["!**"]' || /pi-btw/.test(p.source))) { say('EXTENSION-ISOLATION-MISSING'); process.exit(10); } }
  say('claude-compat/claude-sonnet-5-5 ready');
  if (VARIANT === 'oauth') await fetch(BASE + '/v1/oauth/token', { method: 'POST', body: '{}' }).catch(() => {});
  let child, popup = false, buf = '';
  const startChild = () => { child = spawn(process.execPath, [process.env.FAKE_HELPER, '--child'], { env: { ...process.env, PI_BTW_NATIVE_CONTROL: 'fake' }, stdio: ['pipe', 'pipe', 'inherit'] }); child.stdout.on('data', d => { if (String(d).includes('CHILD-DONE')) say('SIDEOK1'); }); };
  const line = async raw => {
    const t = raw.replace(/\x1b\[20[01]~/g, '').replace(/[\x15\x1d]/g, '').trim();
    if (raw.includes('\x1d')) popup = false;
    if (t.includes('M A I N')) { await call(128000, ['codemode']); say('MAINOK1'); }
    else if (t === '/btw') { if (!child) startChild(); popup = true; if (process.env.FAKE_BTW_NATIVE_DIR && VARIANT !== 'noseedfile') { const fs = await import('node:fs'); fs.mkdirSync(process.env.FAKE_BTW_NATIVE_DIR + '/fake-child', { recursive: true }); fs.writeFileSync(process.env.FAKE_BTW_NATIVE_DIR + '/fake-child/session.jsonl', JSON.stringify({ type: 'session', id: 'x' }) + '\n' + JSON.stringify({ type: 'message', id: 'a1', message: { role: 'user' } }) + '\n' + JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant' } }) + '\n'); } say('BTW popup open'); }
    else if (popup && t.includes('S I D E')) { child.stdin.write('ASK\n'); if (process.env.FAKE_BTW_NATIVE_DIR && VARIANT !== 'noseedfile') (await import('node:fs')).appendFileSync(process.env.FAKE_BTW_NATIVE_DIR + '/fake-child/session.jsonl', JSON.stringify({ type: 'message', id: 'b2', message: { role: 'assistant' } }) + '\n'); }
    else if (t === '/btw:summarize') {
      if (VARIANT !== 'nosummary') await call(VARIANT === 'bigsummary' ? 128000 : 2048, []);
      if (VARIANT === 'extra') for (let i = 0; i < 3; i++) await call(10, []);
      say('Here is a summary of a side conversation I had'); say('Hand off to main');
    }
    else if (t.startsWith('/btw:ask')) { const RO = ['_read', '_grep', '_find', '_ls', '___pi_deferred_placeholder__']; await call(8000, RO, 2); await call(8000, RO, 5); if (VARIANT === 'extra') for (let i = 0; i < 3; i++) await call(10, ['_read', '_grep', '_find', '_ls'], 5); say('SYNTHETIC'); }
    else if (t === '/quit') { if (child) child.stdin.write('BYE\n'); setTimeout(() => process.exit(0), 100); }
  };
  process.stdin.setEncoding('utf8'); process.stdin.setRawMode?.(true);
  process.stdin.on('data', async d => {
    if (d === '\x1b') { say('Handoff cancelled; nothing was sent.'); return; }
    buf += d; let i;
    while ((i = buf.indexOf('\r')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); await line(l); }
    if (buf.includes('\x1d')) { popup = false; buf = buf.replace(/\x1d/g, ''); }
  });
}
