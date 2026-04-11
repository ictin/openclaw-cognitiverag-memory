import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(repoRoot, 'scripts', 'governance_preflight.mjs');

const proc = spawnSync(process.execPath, [script], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(proc.status, 0, `governance preflight should pass:\n${proc.stdout}\n${proc.stderr}`);

const payload = JSON.parse(proc.stdout);
assert.equal(payload.schemaVersion, 'governance_preflight.v1');
assert.equal(payload.passed, true);
assert.ok(Array.isArray(payload.checkedFiles));
assert.ok(Array.isArray(payload.checkedPhrases));

console.log('governance preflight stage d test passed');
