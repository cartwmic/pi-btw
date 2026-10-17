// Heavy-workload classifier for the BTW live smoke preflight. Decides from the verified executable
// (ps comm) and the parsed script/subcommand, never from a substring anywhere in a command line.
// rows: [{pid, ppid, comm, command}]. Returns {blocked:[{pid,rule,command}], shims:[{pid,rule,command}]}.
import path from 'node:path';
const base = s => path.basename(String(s || ''));
const INTERP = /^(python[0-9.]*|node|bun|deno)$/;
const SCRIPT_RULES = [ // console scripts / launched files, matched on a script basename or executable basename
  ['evalctl', n => n === 'evalctl' || n === 'evalctl.py'],
  ['pytest', n => n === 'pytest' || n === 'py.test'],
  ['vitest', n => n === 'vitest' || n === 'vitest.mjs'],
  ['tsc', n => n === 'tsc'],
  ['inspect-software-change', n => n.startsWith('inspect-software-change')],
];
const MODULE_RULES = { pytest: 'pytest', evalctl: 'evalctl', vitest: 'vitest' };
const NATIVE_HEAVY = n => n === 'docker-compose' || n === 'cargo' || n === 'rustc' || n === 'rustdoc' || n === 'clippy-driver' || /^cargo-[a-z0-9-]+$/.test(n);
const CARGO_LIGHT = new Set(['metadata', 'locate-project', 'pkgid', 'verify-project', 'read-manifest', 'version', 'help', 'config']);
const DOCKER_VALUE_FLAGS = new Set(['--context', '-c', '--host', '-H', '--config', '--log-level', '-l', '--tlscacert', '--tlscert', '--tlskey']);

export function tokens(command) { return String(command || '').trim().split(/\s+/).filter(Boolean); }

/** First script file (or -m module) an interpreter was asked to run. */
export function interpreterTarget(exe, args) {
  const python = exe.startsWith('python');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (python && a === '-m') return { module: args[i + 1] };
    if (a === '-c' || a === '-e' || a === '-p' || a === '--eval' || a === '--print') return {};
    if (python && ['-W', '-X', '-Q'].includes(a)) { i++; continue; }
    if (!python && ['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return { script: a };
  }
  return {};
}

function dockerSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (DOCKER_VALUE_FLAGS.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    return args[i];
  }
  return undefined;
}
function cargoSubcommand(args) {
  for (const a of args) { if (a.startsWith('+')) continue; if (a === '--version' || a === '-V' || a === '--help' || a === '-h') return 'version'; if (a.startsWith('-')) continue; return a; }
  return 'help';
}

export function classify(rows, { exclude = [] } = {}) {
  const skip = new Set(exclude.map(Number));
  const blocked = [], shims = [];
  for (const row of rows) {
    if (skip.has(Number(row.pid))) continue;
    const t = tokens(row.command);
    if (!t.length || !row.comm) continue;
    const exe = base(row.comm), argv0 = base(t[0]), args = t.slice(1);
    const hit = (rule, list = blocked) => list.push({ pid: row.pid, rule, command: String(row.command).slice(0, 160) });
    if (INTERP.test(exe)) {
      const target = interpreterTarget(exe, args);
      if (target.module) { if (MODULE_RULES[target.module]) hit(MODULE_RULES[target.module]); continue; }
      if (!target.script) continue;
      const name = base(target.script);
      const rule = SCRIPT_RULES.find(([, test]) => test(name));
      if (rule) { hit(rule[0]); continue; }
      // A script merely NAMED like a native tool (fake_docker.py is not matched; a file called docker/cargo is) is a shim.
      if (name === 'docker' || NATIVE_HEAVY(name)) hit('shim:' + name, shims);
      continue;
    }
    // Native executable: the verified identity is ps comm. A heavy argv[0] on a different executable is not trusted.
    if (argv0 !== exe && (NATIVE_HEAVY(argv0) || argv0 === 'docker')) { hit('identity-mismatch:' + argv0); continue; }
    const rule = SCRIPT_RULES.find(([, test]) => test(exe));
    if (rule) { hit(rule[0]); continue; }
    if (exe === 'docker' && dockerSubcommand(args) === 'compose') { hit('docker-compose'); continue; }
    if (NATIVE_HEAVY(exe)) {
      if (exe === 'cargo' && CARGO_LIGHT.has(cargoSubcommand(args))) { hit('cargo-metadata-only', shims); continue; }
      hit(exe === 'docker-compose' ? 'docker-compose' : exe.startsWith('cargo') || exe.startsWith('rust') || exe === 'clippy-driver' ? 'cargo-rustc' : exe);
    }
  }
  return { blocked, shims };
}

/** Running session-recap workers: the CLI itself, or an interpreter running session_recap.py (verified executable, not a substring). */
export function recapProcesses(rows, { exclude = [] } = {}) {
  const skip = new Set(exclude.map(Number));
  return rows.filter(row => {
    if (skip.has(Number(row.pid)) || !row.comm) return false;
    const t = tokens(row.command), exe = base(row.comm);
    if (exe === 'session-recap') return true;
    if (!INTERP.test(exe)) return false;
    const target = interpreterTarget(exe, t.slice(1));
    return !!target.script && base(target.script) === 'session_recap.py';
  }).map(row => ({ pid: row.pid, command: String(row.command).slice(0, 160) }));
}

/** pids of this process and all its ancestors, from the same ps table. */
export function ancestry(rows, pid) {
  const parent = new Map(rows.map(r => [Number(r.pid), Number(r.ppid)]));
  const out = []; for (let p = Number(pid); p && !out.includes(p); p = parent.get(p)) out.push(p);
  return out;
}

export function readRows(spawnSync) {
  const a = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout.split('\n');
  const b = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n');
  const cmd = new Map();
  for (const l of b) { const m = l.match(/^\s*(\d+)\s+(.*)$/); if (m) cmd.set(Number(m[1]), m[2]); }
  const rows = [];
  for (const l of a) { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); if (m && cmd.has(Number(m[1]))) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3], command: cmd.get(Number(m[1])) }); }
  return rows;
}
