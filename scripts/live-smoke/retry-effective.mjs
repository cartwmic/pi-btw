// Local, no model: effective retry settings that Pi's SettingsManager computes for a project with/without the private override,
// using a temp agent dir with SYNTHETIC content (real settings never read).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { RETRY_OVERRIDE_SETTINGS } from './smoke-analysis.mjs';
const PI = process.env.PI_NODE_MODULES;
const { SettingsManager } = await import(PI + '/@earendil-works/pi-coding-agent/dist/index.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retryeff-')));
const agent = root + '/agent', a = root + '/a', b = root + '/b'; for (const d of [agent, a, b + '/.pi']) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(agent + '/settings.json', JSON.stringify({ theme: 'x', cacheWarming: 'off' }));
fs.writeFileSync(b + '/.pi/settings.json', JSON.stringify(RETRY_OVERRIDE_SETTINGS));
const show = (label, sm) => console.log(label, JSON.stringify({ agentRetry: sm.getRetrySettings(), provider: sm.getProviderRetrySettings() }));
show('no-override   ', SettingsManager.create(a, agent));
show('with-override ', SettingsManager.create(b, agent));
show('override, project NOT trusted (CLI path) ', SettingsManager.create(b, agent, { projectTrusted: false }));
fs.rmSync(root, { recursive: true, force: true });
