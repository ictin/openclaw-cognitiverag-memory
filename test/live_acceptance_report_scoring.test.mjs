import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const scorer = path.join(repoRoot, 'scripts', 'score_live_agent_acceptance.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-score-'));
const closurePayload = {
  schemaVersion: 'live_acceptance_closure.v2',
  totalScore: 21,
  totalMax: 30,
  criticalFailures: [{ id: 'T0.1', reason: 'example fail' }],
  groups: [{ id: 'G0', score: 2, max: 6, fails: 1 }],
};
fs.writeFileSync(path.join(tmpDir, 'final_live_acceptance_results.json'), JSON.stringify(closurePayload, null, 2));

const run = spawnSync('node', [scorer, tmpDir], { encoding: 'utf8' });
assert.equal(run.status, 2, 'scorer should propagate critical failure status for closure report');

const output = String(run.stdout || '').trim();
const parsed = JSON.parse(output);
assert.equal(parsed.reportDir, tmpDir);
assert.equal(parsed.totalScore, 21);
assert.equal(parsed.totalMax, 30);
assert.equal(parsed.criticalHardFailCount, 1);
assert.ok(Array.isArray(parsed.criticalHardFails), 'criticalHardFails should be an array');
console.log('live acceptance report scoring test passed');
