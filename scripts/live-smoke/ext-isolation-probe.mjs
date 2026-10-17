// Local, no model, no credentials: which extensions does Pi's REAL DefaultResourceLoader load for a trusted smoke project,
// with and without the private project-settings extension isolation? The throwaway agent dir holds only a packages-only settings.json,
// a synthetic trust.json and read-only symlinks to the installed package/extension directories (no auth.json, no models.json).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EXTENSION_ISOLATION_SETTINGS } from './smoke-analysis.mjs';
const REAL = path.join(process.env.HOME, '.pi/agent');
const PI = process.env.PI_NODE_MODULES;
const mode = process.argv[2] || 'baseline';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extiso-')));
const agent = root + '/agent', proj = root + '/proj'; fs.mkdirSync(agent); fs.mkdirSync(proj + '/.pi', { recursive: true });
process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agent;
const real = JSON.parse(fs.readFileSync(REAL + '/settings.json', 'utf8'));
fs.writeFileSync(agent + '/settings.json', JSON.stringify({ packages: real.packages }));
fs.writeFileSync(agent + '/trust.json', JSON.stringify({ [root]: true }));
for (const d of ['git', 'npm', 'extensions']) if (fs.existsSync(REAL + '/' + d)) fs.symlinkSync(REAL + '/' + d, agent + '/' + d);
fs.mkdirSync(agent + '/bin', { recursive: true });
if (mode !== 'baseline') fs.writeFileSync(proj + '/.pi/settings.json', JSON.stringify(EXTENSION_ISOLATION_SETTINGS(real.packages)));
const { DefaultResourceLoader, SettingsManager } = await import(PI + '/@earendil-works/pi-coding-agent/dist/index.js');
const sm = SettingsManager.create(proj, agent);
const loader = new DefaultResourceLoader({ cwd: proj, agentDir: agent, settingsManager: sm });
await loader.reload();
const ex = loader.getExtensions();
const short = p => p.replace(REAL, '~AGENT').replace(root, '~ROOT');
const names = ex.extensions.map(e => short(e.path));
const dirs = fs.existsSync(proj + '/.pi') ? fs.readdirSync(proj + '/.pi') : [];
console.log(JSON.stringify({ mode, projDotPi: dirs, projectTrusted: sm.isProjectTrusted?.(), count: names.length, errors: ex.errors.map(e => String(e.error).slice(0, 80)), loaded: names }, null, 0));
fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
