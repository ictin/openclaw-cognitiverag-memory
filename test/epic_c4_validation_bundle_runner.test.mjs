import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(repoRoot, 'scripts', 'run_epic_c4_validation_bundle.mjs');
const outDir = path.join(repoRoot, 'forensics', 'test-epic-c4-validation-runner');

const proc = spawnSync(process.execPath, [script, '--dry-run', '--output-dir', outDir], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(proc.status, 0, `dry-run c4 validation bundle should pass:\n${proc.stderr}`);

const jsonPath = path.join(outDir, 'epic_c4_validation_summary.json');
const mdPath = path.join(outDir, 'epic_c4_validation_summary.md');
assert.ok(fs.existsSync(jsonPath), 'c4 validation runner should emit json summary');
assert.ok(fs.existsSync(mdPath), 'c4 validation runner should emit markdown summary');

const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.equal(payload.schemaVersion, 'epic_c4_validation_bundle.v1');
assert.equal(payload.dryRun, true);
assert.equal(payload.passed, true);
assert.ok(Array.isArray(payload.steps) && payload.steps.length >= 4);

console.log('epic c4 validation bundle runner test passed');
