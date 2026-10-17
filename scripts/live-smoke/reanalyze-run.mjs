// Pure re-analysis of a RETAINED wire log (metadata only). Never modifies result.json; writes reanalysis-<label>.json next to it.
import fs from 'node:fs'; import path from 'node:path';
const [,, runDir, scenario] = process.argv;
const lines = fs.readFileSync(path.join(runDir, 'wire.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const out = {};
for (const [label, mod] of [['original-analyzer', './fixtures/smoke-analysis.pre-ask-reanalysis.mjs'], ['corrected-analyzer', './smoke-analysis.mjs']]) {
  const { analyze } = await import(mod);
  const a = analyze(scenario, structuredClone(lines));
  out[label] = { module: mod, ok: a.ok, failures: a.failures, totalClaims: a.receipt.totalClaims, roles: a.receipt.roles };
}
const orig = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
out.originalRecordedVerdict = { status: orig.status, failures: orig.failures };
out.note = 'Original HOLD is retained in result.json. The corrected verdict applies ONLY to the ask read-only property; it says nothing about the summary check or the A+B combined cap.';
fs.writeFileSync(path.join(runDir, 'reanalysis.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
