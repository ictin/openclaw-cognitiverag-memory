import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(repoRoot, 'scripts', 'run_plugin_ci_smoke.mjs');
const outFile = path.join(repoRoot, 'forensics', 'test-plugin-ci-smoke-summary.json');

const proc = spawnSync(process.execPath, [script, '--output', outFile], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(proc.status, 0, `smoke wrapper should pass without strict runtime requirement:\n${proc.stderr}`);
assert.ok(fs.existsSync(outFile), 'smoke wrapper should emit summary json');

const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
assert.equal(payload.schemaVersion, 'plugin_ci_smoke.v1');
assert.equal(typeof payload.passed, 'boolean');
assert.ok(payload.runtimeProof && typeof payload.runtimeProof === 'object');
assert.equal(typeof payload.runtimeProof.runtimeCodeMatchesRepo, 'boolean');
assert.ok(Array.isArray(payload.errors));

console.log('plugin ci smoke wrapper stage c4 test passed');
