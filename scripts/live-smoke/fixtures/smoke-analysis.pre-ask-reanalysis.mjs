// Pure analysis of the wire-observer log for the BTW live smoke. No I/O. Produces a METADATA-ONLY receipt:
// counts, roles, models, max_tokens, tool NAMES, statuses, header NAMES. No prompt text, URLs, header values or tokens.
export const HARD_TOTAL_CAP = 5;
export const SCENARIOS = {
  // main answer (host) + side answer (btw-child process) + /btw:summarize (in-process SDK summarizer, host process)
  summary: { cap: 3, expectClaims: 3, roles: { host: 2, 'btw-child': 1 }, wireCapMaxTokens: 2048, wireCapCount: 1 },
  // /btw:ask <question using the read tool>: in-process read-only SDK child; tool call round trip
  ask: { cap: 2, minClaims: 2, maxClaims: 2, roles: { host: 'all' }, readonlyTools: ['find', 'grep', 'ls', 'read'] },
};
// The claude-compat OAuth route renames tools on the wire (observed through the real wrapper: read -> _read). Compare names
// case-insensitively with one leading underscore removed; the SET must still be exactly the read-only four, no more, no fewer.
export const normToolName = (n) => String(n).replace(/^_/, '').toLowerCase();
const eqSet = (a, b) => { const x = a.map(normToolName).sort(), y = b.map(normToolName).sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };

export function analyze(scenario, lines, { model = 'sonnet-5-5' } = {}) {
  const spec = SCENARIOS[scenario];
  const failures = [];
  const fail = m => failures.push(m);
  if (!spec) return { ok: false, failures: ['unknown scenario ' + scenario], receipt: {} };
  const claims = lines.filter(l => l.ev === 'claim');
  const responses = lines.filter(l => l.ev === 'response');
  const blocked = lines.filter(l => l.ev === 'BLOCKED');
  const auth = lines.filter(l => l.ev === 'AUTH-TRAFFIC');
  const roles = {}; for (const c of claims) roles[c.role] = (roles[c.role] || 0) + 1;
  if (blocked.length) fail('request bound hit: ' + blocked.length + ' request(s) blocked (a request beyond the scenario cap was attempted)');
  if (auth.length) fail('OAuth traffic observed (' + auth.length + '): a token refresh may have occurred');
  if (claims.length > HARD_TOTAL_CAP) fail('claims ' + claims.length + ' exceed hard cap ' + HARD_TOTAL_CAP);
  if (claims.length > spec.cap) fail('claims ' + claims.length + ' exceed scenario cap ' + spec.cap);
  if (claims.some(c => c.parsed === false)) fail('a provider request body could not be parsed, so its max_tokens/tools are unknown (proof gap)');
  if (!claims.every(c => new RegExp(model).test(String(c.model)))) fail('non-' + model + ' model on the wire: ' + JSON.stringify(claims.map(c => c.model)));
  const byN = new Map(responses.map(r => [r.n, r]));
  for (let i = 0; i < claims.length; i++) {
    const r = responses.find(x => x.t >= claims[i].t && x.pid === claims[i].pid && !x.__used);
    if (r) r.__used = true;
  }
  if (responses.length !== claims.length) fail('responses ' + responses.length + ' != claims ' + claims.length + ' (a request got no response record)');
  if (!responses.every(r => r.status === 200)) fail('non-200 response: ' + JSON.stringify(responses.map(r => r.status)));
  if ('expectClaims' in spec && claims.length !== spec.expectClaims) fail('expected exactly ' + spec.expectClaims + ' claims, saw ' + claims.length);
  if ('minClaims' in spec && (claims.length < spec.minClaims || claims.length > spec.maxClaims)) fail('expected ' + spec.minClaims + '-' + spec.maxClaims + ' claims, saw ' + claims.length);
  if (scenario === 'summary') {
    for (const [role, n] of Object.entries(spec.roles)) if ((roles[role] || 0) !== n) fail('role ' + role + ': expected ' + n + ', saw ' + (roles[role] || 0));
    const capped = claims.filter(c => typeof c.max_tokens === 'number' && c.max_tokens <= spec.wireCapMaxTokens);
    if (capped.length !== spec.wireCapCount) fail('expected exactly ' + spec.wireCapCount + ' request with max_tokens<=' + spec.wireCapMaxTokens + ', saw ' + capped.length + ' of ' + JSON.stringify(claims.map(c => c.max_tokens)));
    else if (capped[0].role !== 'host') fail('the <=2048 request is not from the host process (summarizer expected in-process): role ' + capped[0].role);
    else if ((capped[0].toolCount ?? 0) !== 0) fail('summarizer request carried tools: ' + JSON.stringify(capped[0].tools));
    const big = claims.filter(c => !(typeof c.max_tokens === 'number' && c.max_tokens <= spec.wireCapMaxTokens));
    if (!big.every(c => typeof c.max_tokens === 'number')) fail('a non-summarizer request has no max_tokens');
  }
  if (scenario === 'ask') {
    if (!claims.every(c => eqSet(c.tools || [], spec.readonlyTools))) fail('tool set on the wire is not exactly ' + spec.readonlyTools.join(',') + ': ' + JSON.stringify(claims.map(c => c.tools)));
    if (!claims.every(c => c.role === 'host')) fail('ask expected in-process (host) requests only: ' + JSON.stringify(roles));
  }
  const receipt = {
    scenario, totalClaims: claims.length, roles, wireCap: spec.cap, hardCap: HARD_TOTAL_CAP, blocked: blocked.length, authTraffic: auth.length,
    requests: claims.map((c, i) => ({ n: i + 1, role: c.role, api: c.api, model: c.model, max_tokens: c.max_tokens, stream: c.stream, messages: c.messages, toolNames: c.tools, bytes: c.bytes })),
    responses: responses.map(r => ({ status: r.status, headerNamesOnly: r.headerNamesOnly })),
  };
  return { ok: failures.length === 0, failures, receipt };
}
export function otherHosts(lines) { return [...new Set(lines.filter(l => l.ev === 'other').map(l => l.host))].sort(); }

// Preflight OAuth lifetime gate. A run (incl. preflight and cleanup) is budgeted <= 6 min, so 20 min of remaining life means
// no refresh should be needed. Strictly greater-than, as before. Non-numeric/missing/expired -> false (fail closed).
export const MIN_OAUTH_REMAINING_S = 1200;
export function oauthMarginOk(expires, nowMs, minS = MIN_OAUTH_REMAINING_S) {
  if (typeof expires !== 'number' || !Number.isFinite(expires) || !Number.isFinite(nowMs)) return false;
  const expS = expires > 1e12 ? expires / 1000 : expires;
  return expS - nowMs / 1000 > minS;
}

// Test-only PRIVATE launch override, written to <smoke project>/.pi/settings.json (project settings merge over global when the
// project is trusted; the driver's inherited-trust assertion guarantees that). Global ~/.pi/agent/settings.json is never modified.
// Honors the owner's "no automatic retry": Pi agent-level auto-retry off, and provider/SDK retries explicitly 0.
export const RETRY_OVERRIDE_SETTINGS = { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } };

// Smoke-only extension isolation. HOST: launched with -ne -e <pi-btw btw.ts> -e <claude-compat-guard/index.ts> (the guard loads the pinned
// Claude Compat provider; the compat package itself is disabled in the personal config). CHILD (native /btw, a separate Pi process that
// the extension spawns without flags) and in-process sessions read the smoke project's settings: every personal PACKAGE except pi-btw gets
// a project entry with autoload:false (a DELTA over the user-scope install, so nothing is cloned or installed) and extensions ['!**'].
// LIMIT (source: package-manager.js addAutoDiscoveredResources): auto-discovered ~/.pi/agent/extensions/* are filtered by GLOBAL settings
// only, so the child still loads those; they cannot be removed without changing global settings or the agent dir.
export const KEEP_EXTENSION_SOURCES = ['https://github.com/cartwmic/pi-btw'];
export const EXTENSION_ISOLATION_SETTINGS = (personalPackages) => ({
  packages: (personalPackages || []).map(p => typeof p === 'string' ? p : p.source)
    .filter(src => !KEEP_EXTENSION_SOURCES.includes(src) && !/pi-claude-request-compat/.test(src))
    .map(source => ({ source, autoload: false, extensions: ['!**'] })),
});
export const hostExtensionArgs = (btwPath, guardPath) => ['-ne', '-e', btwPath, '-e', guardPath];
