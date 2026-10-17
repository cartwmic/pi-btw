// Wire-level provider observer + ENFORCED shared request bound for the BTW live smoke.
// Loaded with NODE_OPTIONS=--import=<this file>, so it runs in the host Pi, the native /btw child (separate process,
// inherits env) and the in-process summarizer session alike, independent of any Pi extension runtime.
// Metadata only: model, max_tokens, stream, message count, tool NAMES, byte size, response status, rate-limit header NAMES.
// Never logs prompt text, header values, tokens or URLs beyond the host name.
// Bound: every provider request first appends a 'claim' line to the shared log (one O_APPEND write), then counts claim lines.
// If the count is above SMOKE_WIRE_CAP the request is NOT sent (it throws) and a 'BLOCKED' line is appended. Concurrent processes can
// only over-count, never under-count, so the number of requests actually sent never exceeds the cap. Logging failures fail closed.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.SMOKE_WIRE_LOG;
if (LOG && !globalThis.__smokeWireInstalled) {
  globalThis.__smokeWireInstalled = true;
  const CAP = Number(process.env.SMOKE_WIRE_CAP || 5);
  const EXTRA_HOSTS = (process.env.SMOKE_WIRE_HOSTS || '').split(',').filter(Boolean);
  const role = () => (process.env.PI_BTW_NATIVE_CONTROL ? 'btw-child' : 'host');
  const append = (file, o) => fs.appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, role: role(), ...o }) + '\n');
  const isProvider = (url, method) => {
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    if (/\/oauth(\/|$)/.test(url.pathname)) return false; // token refresh is not a model request; flagged separately
    return /(^|\.)anthropic\.com$/.test(url.hostname) || EXTRA_HOSTS.includes(url.host)
      || /\/v1\/messages$|\/chat\/completions$|\/v1\/responses$/.test(url.pathname);
  };
  const meta = (bodyText) => {
    let p = {};
    try { p = JSON.parse(bodyText); } catch { return { parsed: false, bytes: bodyText?.length ?? 0 }; }
    const tools = Array.isArray(p.tools) ? p.tools.map(t => t && t.name) : [];
    return { parsed: true, model: p.model, max_tokens: p.max_tokens ?? p.maxTokens ?? p.max_output_tokens, stream: p.stream,
      messages: Array.isArray(p.messages) ? p.messages.length : undefined, tools, toolCount: tools.length, thinking: p.thinking !== undefined, bytes: bodyText.length };
  };
  const claim = (api, m) => {
    // fail closed: any error while recording or counting blocks the request
    try {
      append(LOG, { ev: 'claim', api, ...m });
      const n = fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.includes('"ev":"claim"')).length;
      if (n > CAP) { append(LOG, { ev: 'BLOCKED', n, cap: CAP }); throw new Error('BTW smoke provider request bound exceeded (' + n + ' > ' + CAP + ')'); }
      return n;
    } catch (e) {
      if (String(e.message).includes('bound exceeded')) throw e;
      throw new Error('BTW smoke wire observer failed closed: ' + (e && e.code || 'error'));
    }
  };
  const other = (url, method) => { try { append(LOG + '.other', { ev: 'other', host: url.host, method }); if (/\/oauth(\/|$)/.test(url.pathname)) append(LOG, { ev: 'AUTH-TRAFFIC', host: url.host, method }); } catch {} };
  const headerNames = h => { try { return [...h.keys()].filter(k => /ratelimit|overage|extra|billing/i.test(k) && !/token|key|auth|cookie/i.test(k)).sort(); } catch { return []; } };

  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = async function observedFetch(input, init) {
      let url, method, bodyText;
      try {
        url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
        const b = init && init.body;
        if (typeof b === 'string') bodyText = b;
        else if (b && (b instanceof Uint8Array || Buffer.isBuffer(b))) bodyText = Buffer.from(b).toString('utf8');
        else if (!b && typeof input === 'object' && input && typeof input.clone === 'function' && String(method).toUpperCase() === 'POST') bodyText = await input.clone().text();
      } catch { return realFetch.call(this, input, init); }
      if (!isProvider(url, method)) { other(url, String(method).toUpperCase()); return realFetch.call(this, input, init); }
      const n = claim('fetch', { host: url.host, ...meta(bodyText ?? '') });
      const res = await realFetch.call(this, input, init);
      try { append(LOG, { ev: 'response', n, status: res.status, headerNamesOnly: headerNames(res.headers) }); } catch {}
      return res;
    };
  }
  // Non-fetch HTTP clients (never used by the Anthropic SDK path, covered so a future route cannot escape the bound).
  for (const mod of [http, https]) {
    const real = mod.request;
    const wrapped = function (...args) {
      try {
        const [first, second] = args;
        let url;
        if (typeof first === 'string' || first instanceof URL) url = new URL(String(first));
        else { const o = first || {}; url = new URL((o.protocol || (mod === https ? 'https:' : 'http:')) + '//' + (o.hostname || o.host || 'localhost') + (o.port ? ':' + o.port : '') + (o.path || '/')); }
        const opts = (typeof first === 'string' || first instanceof URL) ? second : first;
        const method = (opts && opts.method) || 'GET';
        if (isProvider(url, method)) claim('node-http', { host: url.host, parsed: false });
        else other(url, String(method).toUpperCase());
      } catch (e) { if (String(e.message).includes('bound exceeded') || String(e.message).includes('failed closed')) throw e; }
      return real.apply(this, args);
    };
    mod.request = wrapped;
    mod.get = function (...args) { const r = wrapped.apply(this, args); r.end(); return r; };
  }
  syncBuiltinESMExports(); // so ESM named imports (import { request } from 'node:http') see the wrappers too
}
