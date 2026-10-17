import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, ancestry, interpreterTarget, recapProcesses } from './heavy-overlap.mjs';
const PY = '/Users/x/.local/share/mise/installs/python/latest/bin/python3';
const row = (pid, comm, command, ppid = 1) => ({ pid, ppid, comm, command });
const rules = rows => classify(rows).blocked.map(b => b.rule);
const E = '/opt/example/loop-engine/evals/.venv/bin';

test('the real false positive is allowed: Eval fake-shim tests under an sc-model-eval-suite path', () => {
  const rows = [
    row(10, '/bin/bash', '/bin/bash -c python3 /tmp/fix22.py && cd /Users/x/.local/share/loop-engine/runs/sc-model-eval-suite-20261004/h && python3 test_stage_a.py x.json'),
    row(11, PY, 'python3 test_stage_a.py /Users/x/.local/share/loop-engine/runs/sc-model-eval-suite-20261004/implementation-handoff-rev6-20261015/stage-a/stage-a-results-final.json', 10),
    row(12, PY, PY + ' /Users/x/.local/share/loop-engine/runs/sc-model-eval-suite-20261004/implementation-handoff-rev6-20261015/stage-a/fake_docker.py top AAAA', 11),
    row(13, PY, PY + ' /Users/x/.local/share/loop-engine/runs/sc-model-eval-suite-20261004/mut3.py'),
  ];
  assert.deepEqual(classify(rows).blocked, []);
});
test('actual evalctl campaigns are blocked, as venv console script, module, or native', () => {
  assert.deepEqual(rules([row(1, E + '/python', E + '/python ' + E + '/evalctl campaign run --all')]), ['evalctl']);
  assert.deepEqual(rules([row(2, PY, PY + ' -m evalctl campaign')]), ['evalctl']);
  assert.deepEqual(rules([row(3, '/usr/local/bin/evalctl', 'evalctl campaign run')]), ['evalctl']);
});
test('pytest, vitest and tsc are blocked however launched', () => {
  assert.deepEqual(rules([row(1, PY, PY + ' -m pytest -q evals')]), ['pytest']);
  assert.deepEqual(rules([row(2, PY, PY + ' /v/bin/pytest -q')]), ['pytest']);
  assert.deepEqual(rules([row(3, '/n/bin/node', '/n/bin/node /r/node_modules/.bin/vitest run')]), ['vitest']);
  assert.deepEqual(rules([row(4, '/n/bin/node', 'node --max-old-space-size=4096 /r/node_modules/vitest/vitest.mjs run')]), ['vitest']);
  assert.deepEqual(rules([row(5, '/n/bin/node', '/n/bin/node /r/node_modules/.bin/tsc -p .')]), ['tsc']);
  assert.deepEqual(rules([row(6, '/n/bin/node', 'node -r ts-node/register /r/node_modules/typescript/bin/tsc')]), ['tsc']);
});
test('docker compose (plugin form, flags before it, and docker-compose) is blocked; other docker use is not', () => {
  assert.deepEqual(rules([row(1, '/usr/local/bin/docker', 'docker compose up -d')]), ['docker-compose']);
  assert.deepEqual(rules([row(2, '/usr/local/bin/docker', 'docker --context desktop-linux compose -f x.yml up')]), ['docker-compose']);
  assert.deepEqual(rules([row(3, '/usr/local/bin/docker-compose', 'docker-compose up')]), ['docker-compose']);
  assert.deepEqual(rules([row(4, '/usr/local/bin/docker', 'docker ps')]), []);
  assert.deepEqual(rules([row(5, '/usr/local/bin/docker', 'docker run --rm alpine echo compose')]), []);
});
test('cargo and rustc workloads are blocked; cargo metadata scripts are classified light', () => {
  const c = '/Users/x/.cargo/bin/cargo';
  assert.deepEqual(rules([row(1, c, 'cargo build --release')]), ['cargo-rustc']);
  assert.deepEqual(rules([row(2, c, 'cargo +nightly clippy --all-targets')]), ['cargo-rustc']);
  assert.deepEqual(rules([row(3, '/Users/x/.rustup/toolchains/s/bin/rustc', 'rustc --crate-name foo src/lib.rs')]), ['cargo-rustc']);
  assert.deepEqual(rules([row(4, '/Users/x/.cargo/bin/cargo-nextest', 'cargo-nextest nextest run')]), ['cargo-rustc']);
  const light = classify([row(5, c, 'cargo metadata --format-version 1 --no-deps'), row(6, c, 'cargo --version'), row(7, c, 'cargo locate-project')]);
  assert.deepEqual(light.blocked, []);
  assert.equal(light.shims.length, 3);
});
test('inspect-software-change runs are blocked by script name, not by path text', () => {
  assert.deepEqual(rules([row(1, PY, PY + ' /s/inspect-software-change-run.py --all')]), ['inspect-software-change']);
  assert.deepEqual(rules([row(2, PY, PY + ' /s/other.py --note inspect-software-change')]), []);
});
test('a path or argument that merely contains a tool name is not a workload', () => {
  const rows = [
    row(1, PY, PY + ' /runs/evalctl-notes/summary.py'),
    row(2, '/usr/bin/grep', 'grep -r pytest vitest tsc /repo'),
    row(3, '/bin/bash', 'bash -c cargo build && pytest -q evals && docker compose up'),
    row(4, '/usr/bin/vim', 'vim /repo/docker-compose.yml'),
    row(5, '/Applications/Docker.app/Contents/MacOS/com.docker.backend', '/Applications/Docker.app/Contents/MacOS/com.docker.backend services'),
    row(6, PY, PY + ' -c import subprocess; subprocess.run(["pytest"])'),
  ];
  assert.deepEqual(classify(rows).blocked, []);
});
test('interpreter scripts named like native tools are shims, but a spoofed argv[0] on another executable is not trusted', () => {
  const shim = classify([row(1, '/bin/bash', '/bin/bash /t/docker compose up'), row(2, PY, PY + ' /t/cargo build')]);
  assert.deepEqual(shim.blocked, []);
  assert.deepEqual(shim.shims.map(s => s.rule), ['shim:cargo']); // bash-hosted file is not an interpreter target here; python-hosted 'cargo' is recorded
  assert.equal(classify([row(3, '/tmp/innocuous', 'docker compose up')]).blocked[0].rule, 'identity-mismatch:docker');
});
test('own process and its ancestors are excluded', () => {
  const rows = [row(100, '/bin/zsh', 'zsh', 1), row(200, PY, PY + ' -m pytest', 100), row(300, '/n/bin/node', 'node driver.mjs', 200)];
  assert.deepEqual(ancestry(rows, 300), [300, 200, 100, 1]);
  assert.deepEqual(classify(rows, { exclude: ancestry(rows, 300) }).blocked, []);
  assert.equal(classify(rows).blocked.length, 1);
});
test('recap workers are detected by executable and script, not by substring', () => {
  const rows = [
    row(1, PY, PY + ' /Users/x/.local/share/session-recap/session_recap.py list --json'),
    row(2, '/Users/x/.local/bin/session-recap', 'session-recap list --json'),
    row(3, '/usr/bin/grep', 'grep session_recap.py /tmp/x'),
    row(4, '/usr/bin/vim', 'vim /Users/x/.local/share/session-recap/session_recap.py'),
    row(5, '/bin/bash', 'bash -c echo session_recap.py'),
    row(6, PY, PY + ' /Users/x/other/not_session_recap.py'),
  ];
  assert.deepEqual(recapProcesses(rows).map(r => r.pid), [1, 2]);
  assert.deepEqual(recapProcesses(rows, { exclude: [1] }).map(r => r.pid), [2]);
});
test('malformed rows are ignored, interpreter target parsing', () => {
  assert.deepEqual(classify([row(1, '', 'x'), row(2, PY, ''), { pid: 3 }]).blocked, []);
  assert.deepEqual(interpreterTarget('python3.14', ['-I', '-B', '-X', 'dev', 'a.py']), { script: 'a.py' });
  assert.deepEqual(interpreterTarget('node', ['-e', 'x']), {});
});
