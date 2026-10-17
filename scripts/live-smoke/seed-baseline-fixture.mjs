const B = process.env.BTW_EXT;
// Local, synthetic: what does the contextual native child's session file look like at seed time versus after one side answer?
// Uses the INSTALLED btw-seed.ts (seedNativeSession/blankNativeSession) and btw-menu.ts (sideThreadFromSession). No network, no credentials.
import { createRequire } from 'node:module';
const PIM = process.env.HOME + '/.pi/agent/install/releases/1.1.0/node_modules';
const req = createRequire(PIM + '/@earendil-works/pi-coding-agent/package.json');
let jitiMod; try { jitiMod = req('@mariozechner/jiti'); } catch { try { jitiMod = req('jiti'); } catch { jitiMod = await import(PIM + '/jiti/lib/jiti.mjs'); } }
const createJiti = jitiMod.createJiti ?? jitiMod.default?.createJiti ?? jitiMod.default ?? jitiMod;
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true, alias: Object.fromEntries(['pi-coding-agent','pi-tui','pi-ai','pi-agent-core'].map(n => ['@earendil-works/' + n, PIM + '/@earendil-works/' + n])) });
const { seedNativeSession, blankNativeSession } = await jiti.import(B + '/btw-seed.ts');
const { sideThreadFromSession } = await jiti.import(B + '/btw-menu.ts');
const ts = Date.now();
const cut = (branch) => JSON.stringify({ version: 1, kind: 'pi-conversation-snapshot', source: { header: { type: 'session', version: 3, id: 'main-synth', timestamp: new Date(ts).toISOString(), cwd: '/tmp/x' }, cwd: '/tmp/x', leafId: branch.at(-1)?.id ?? null },
  branch, model: { provider: 'claude-compat', id: 'claude-sonnet-5-5' }, thinkingLevel: 'low', runtime: { finalized: [], streamingMessage: null, pendingToolCalls: [], toolObservations: [], isStreaming: false } });
const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts } });
const asst = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'claude-compat', model: 'claude-sonnet-5-5', stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, timestamp: ts } });
const countAsst = (jsonl) => jsonl.split('\n').filter(l => l.includes('"role":"assistant"')).length; // the driver's exact cross-check predicate
const main = [user('u1', null, 'synthetic main prompt'), asst('a1', 'u1', 'MAINOK1')];
const out = {};
const seeded = seedNativeSession(cut(main));
out.contextual = { assistantLinesAtSeed: countAsst(seeded.jsonl) };
const seedLeaf = seeded.jsonl.trim().split('\n').map(l => JSON.parse(l)).at(-1).id;
const side = [user('s1', seedLeaf, 'synthetic side prompt'), asst('s2', 's1', 'SIDEOK1')].map(e => JSON.stringify(e)).join('\n') + '\n';
const after = seeded.jsonl + side;
out.contextual.assistantLinesAfterOneSideAnswer = countAsst(after);
const th = sideThreadFromSession(after, seedLeaf); out.contextual.sideThreadScope = th.scope; out.contextual.sideExchanges = th.exchanges.length;
const blank = blankNativeSession(cut(main)); out.blank = { assistantLinesAtSeed: countAsst(blank.jsonl), afterOneSideAnswer: countAsst(blank.jsonl + side) };
console.log('RESULT ' + JSON.stringify(out)); process.exit(0);
