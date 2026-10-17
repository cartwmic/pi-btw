import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, oauthMarginOk, MIN_OAUTH_REMAINING_S, normToolName, RESERVED_PLACEHOLDER, childCrossCheck, assistantLines } from './smoke-analysis.mjs';
import fs from 'node:fs';
let t = 1000;
const claim = (role, max_tokens, o = {}) => ({ t: ++t, pid: o.pid ?? (role === 'host' ? 1 : 2), ev: 'claim', role, api: 'fetch', model: 'claude-sonnet-5-5', max_tokens, stream: true, messages: o.messages ?? 2, tools: o.tools ?? [], toolCount: (o.tools ?? []).length, parsed: true, bytes: 100 });
const resp = (pid = 1) => ({ t: ++t, pid, ev: 'response', n: 1, status: 200, headerNamesOnly: ['anthropic-ratelimit-unified-status'] });
const good = () => [claim('host', 128000, { tools: ['codemode'] }), resp(1), claim('btw-child', 128000, { pid: 2, tools: ['read', 'ls'] }), resp(2), claim('host', 2048), resp(1)];
const ok = (s, l) => analyze(s, l);

test('summary scenario passes with main + child + capped summarizer, receipt is metadata only', () => {
  const r = ok('summary', good()); assert.deepEqual(r.failures, []); assert.equal(r.ok, true);
  assert.deepEqual(r.receipt.requests.map(x => [x.role, x.max_tokens]), [['host', 128000], ['btw-child', 128000], ['host', 2048]]);
  const text = JSON.stringify(r.receipt); assert.ok(!/content|text|prompt|authorization|bearer/i.test(text.replace(/headerNamesOnly|bytes/g, '')));
});
test('missing summarizer claim is a proof gap, not a pass (the s3 situation)', () => {
  const l = good().filter((_, i) => i < 4); const r = ok('summary', l);
  assert.equal(r.ok, false); assert.match(r.failures.join('|'), /expected exactly 3 claims, saw 2/); assert.match(r.failures.join('|'), /max_tokens<=2048/);
});
test('summarizer without the cap on the wire fails', () => {
  const l = good(); l[4].max_tokens = 128000; assert.match(ok('summary', l).failures.join('|'), /max_tokens<=2048, saw 0/);
});
test('summarizer carrying tools, or from the child process, fails', () => {
  const a = good(); a[4].tools = ['read']; a[4].toolCount = 1; assert.match(ok('summary', a).failures.join('|'), /carried tools/);
  const b = good(); b[4].role = 'btw-child'; assert.match(ok('summary', b).failures.join('|'), /role host: expected 2|not from the host/);
});
test('extra request beyond scenario cap or a BLOCKED record fails', () => {
  const l = [...good(), claim('host', 10), resp(1)]; assert.match(ok('summary', l).failures.join('|'), /exceed scenario cap 3/);
  const m = [...good(), { t: ++t, pid: 1, ev: 'BLOCKED', n: 4, cap: 3 }]; assert.match(ok('summary', m).failures.join('|'), /request bound hit/);
});
test('non-sonnet model, non-200, missing response, unparsed body, auth traffic each fail', () => {
  const a = good(); a[0].model = 'claude-opus-5-5'; assert.match(ok('summary', a).failures.join('|'), /non-sonnet/);
  const b = good(); b[1].status = 429; assert.match(ok('summary', b).failures.join('|'), /non-200/);
  const c = good(); c.splice(5, 1); assert.match(ok('summary', c).failures.join('|'), /responses 2 != claims 3/);
  const d = good(); d[0].parsed = false; assert.match(ok('summary', d).failures.join('|'), /could not be parsed/);
  const e = [...good(), { t: ++t, pid: 1, ev: 'AUTH-TRAFFIC' }]; assert.match(ok('summary', e).failures.join('|'), /OAuth traffic/);
});
test('ask scenario: read-only tool set exactly, in-process, exactly 2 claims', () => {
  const ro = ['read', 'grep', 'find', 'ls'];
  const g = [claim('host', 8000, { tools: ro }), resp(), claim('host', 8000, { tools: ro, messages: 5 }), resp()];
  assert.deepEqual(ok('ask', g).failures, []);
  const bad = [claim('host', 8000, { tools: [...ro, 'bash'] }), resp()]; assert.match(ok('ask', bad).failures.join('|'), /tool set on the wire/);
  assert.match(ok('ask', [claim('host', 1, { tools: ro }), resp()]).failures.join('|'), /expected 2-2 claims, saw 1/);
  const child = [claim('btw-child', 8000, { tools: ro }), resp(2), claim('host', 8000, { tools: ro }), resp()]; assert.match(ok('ask', child).failures.join('|'), /one process role/);
});
test('unknown scenario fails closed', () => assert.equal(analyze('x', []).ok, false));

test('OAuth margin: constant is 20 min and boundaries are strict (just below / at / just above), seconds and ms inputs', () => {
  assert.equal(MIN_OAUTH_REMAINING_S, 1200);
  const now = 1_800_000_000_000; // ms
  for (const unit of ['s', 'ms']) {
    const at = (offS) => unit === 'ms' ? now + offS * 1000 : now / 1000 + offS;
    assert.equal(oauthMarginOk(at(1199), now), false, unit + ' just below');
    assert.equal(oauthMarginOk(at(1200), now), false, unit + ' exactly at (strictly greater required)');
    assert.equal(oauthMarginOk(at(1201), now), true, unit + ' just above');
    assert.equal(oauthMarginOk(at(47 * 60), now), true, unit + ' 47 min (current real state) passes');
    assert.equal(oauthMarginOk(at(-5), now), false, unit + ' already expired');
  }
});
test('OAuth margin fails closed on unreadable expiry', () => {
  for (const bad of [undefined, null, NaN, '1900000000', Infinity, {}]) assert.equal(oauthMarginOk(bad, 1_800_000_000_000), false, String(bad));
  assert.equal(oauthMarginOk(1_900_000_000, NaN), false);
});
test('driver wires the gate through oauthMarginOk, keeps zero-OAuth-traffic and hash checks, and has no stale 3600 literal', () => {
  const src = fs.readFileSync(new URL('./live-smoke-driver-v4.mjs', import.meta.url), 'utf8');
  assert.match(src, /oauthMarginOk\(auth\.expires,Date\.now\(\)\)/);
  assert.doesNotMatch(src, />3600/);
  assert.match(src, /unchanged\.auth&&result\.unchanged\.trust&&result\.unchanged\.settings/);
});
test('OAuth traffic on the wire still fails the run regardless of margin', () => {
  const l = [...good(), { t: ++t, pid: 1, ev: 'AUTH-TRAFFIC' }];
  assert.equal(analyze('summary', l).ok, false);
});

test('ask scenario: compat-renamed tool names (_read etc.) still pass, but extra, missing or write tools fail', () => {
  const mk = (names) => [claim('host', 128000, { tools: names }), resp(1), claim('host', 128000, { tools: names, messages: 5 }), resp(1)];
  assert.equal(analyze('ask', mk(['_find', '_grep', '_ls', '_read'])).ok, true);
  assert.equal(analyze('ask', mk(['Find', 'Grep', 'Ls', 'Read'])).ok, true);
  assert.equal(analyze('ask', mk(['_find', '_grep', '_ls'])).ok, false, 'missing read');
  assert.equal(analyze('ask', mk(['_find', '_grep', '_ls', '_read', '_bash'])).ok, false, 'extra bash');
  assert.equal(analyze('ask', mk(['_find', '_grep', '_ls', '_write'])).ok, false, 'write instead of read');
  assert.equal(normToolName('__read'), '_read');
});

test('B cap 2: a third request fails the ask check (cap 2 is a hard scenario limit, not 3)', () => {
  const ro = ['read', 'grep', 'find', 'ls'];
  const three = [claim('host', 8000, { tools: ro }), resp(), claim('host', 8000, { tools: ro }), resp(), claim('host', 8000, { tools: ro }), resp()];
  const r = analyze('ask', three); assert.equal(r.ok, false); assert.match(r.failures.join('|'), /exceed scenario cap 2/);
});

// ---- ask reanalysis (after live run B). Realistic shape: native child, underscore names, reserved placeholder, 2 -> 5 messages.
const RO_REAL = ['_read', '_grep', '_find', '_ls', '___pi_deferred_placeholder__'];
const askRun = (o = {}) => [
  claim(o.role ?? 'btw-child', 64000, { pid: 7, tools: o.t1 ?? RO_REAL, messages: 2 }), resp(7),
  claim(o.role2 ?? o.role ?? 'btw-child', 64000, { pid: 7, tools: o.t2 ?? o.t1 ?? RO_REAL, messages: o.m2 ?? 5 }), resp(7),
];
test('ASK v2: the exact live run B shape (native child, placeholder, 2->5 messages) passes', () => {
  const r = analyze('ask', askRun()); assert.deepEqual(r.failures, []); assert.equal(r.ok, true);
  assert.equal(RESERVED_PLACEHOLDER, '__pi_deferred_placeholder__');
});
test('ASK v2: still fails on extra/missing/write tools, other extra names, mixed roles, no round trip, third request, wrong model', () => {
  const ro = ['_read', '_grep', '_find', '_ls'];
  assert.equal(analyze('ask', askRun({ t1: [...ro, '_bash', '___pi_deferred_placeholder__'] })).ok, false, 'bash');
  assert.equal(analyze('ask', askRun({ t1: [...ro, '_write'] })).ok, false, 'write');
  assert.equal(analyze('ask', askRun({ t1: ['_read', '_grep', '_find', '___pi_deferred_placeholder__'] })).ok, false, 'missing ls');
  assert.equal(analyze('ask', askRun({ t1: [...ro, '_mystery_tool'] })).ok, false, 'unknown extra name');
  assert.equal(analyze('ask', askRun({ role: 'btw-child', role2: 'host' })).ok, false, 'mixed roles');
  assert.equal(analyze('ask', askRun({ m2: 2 })).ok, false, 'no round trip');
  assert.equal(analyze('ask', askRun({ m2: 1 })).ok, false, 'fewer messages');
  assert.equal(analyze('ask', [...askRun(), claim('btw-child', 64000, { pid: 7, tools: RO_REAL, messages: 7 }), resp(7)]).ok, false, 'third request');
  const bad = askRun(); bad[0].model = 'claude-opus-5'; assert.equal(analyze('ask', bad).ok, false, 'model');
  assert.equal(analyze('ask', askRun({ role: 'host' })).ok, true, 'in-process host route is also accepted');
});
test('ASK v2 does not change the summary scenario (summary still requires host=2, btw-child=1)', () => {
  assert.equal(analyze('summary', good()).ok, true);
  const bad = good(); bad[0].role = 'btw-child'; assert.equal(analyze('summary', bad).ok, false);
});

// ---- seed-baseline cross-check (live run s6 lesson)
test('child cross-check: inherited assistant lines are not counted; the live s6 shape (seed 1 -> end 2, wire 1) passes', () => {
  assert.deepEqual(childCrossCheck({ seed: { 'd/s.jsonl': 1 }, end: { 'd/s.jsonl': 2 }, wireChild: 1 }), { failures: [], side: 1 });
  assert.equal(assistantLines('{"type":"message","message":{"role":"assistant"}}\n{"message":{"role":"user"}}\n'), 1);
});
test('child cross-check fails on a real mismatch (extra or missing child answers) and FAILS CLOSED without a baseline', () => {
  assert.equal(childCrossCheck({ seed: { a: 1 }, end: { a: 3 }, wireChild: 1 }).failures.length, 1, 'two answers added but one wire request');
  assert.equal(childCrossCheck({ seed: { a: 1 }, end: { a: 1 }, wireChild: 1 }).failures.length, 1, 'no answer added but one wire request');
  for (const seed of [undefined, null, {}]) assert.match(childCrossCheck({ seed, end: { a: 2 }, wireChild: 1 }).failures.join('|'), /proof gap/);
  assert.equal(childCrossCheck({ seed: { a: 1 }, end: { a: 2, b: 1 }, wireChild: 2 }).failures.length, 0, 'a file created after the seed counts fully');
});
