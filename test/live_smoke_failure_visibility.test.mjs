import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const script = path.join(repoRoot, 'scripts', 'run_memory_live_smoke.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-smoke-fail-'));
const fakeRepo = path.join(tmpDir, 'fake-repo');
fs.mkdirSync(fakeRepo, { recursive: true });
const benchmarkSummaryPath = path.join(tmpDir, 'benchmark-summary.json');
fs.writeFileSync(benchmarkSummaryPath, JSON.stringify({ passed: true, cases: [{ name: 'ok', ok: true }] }, null, 2));

const stamp = `test-smoke-fail-${Date.now()}`;
const run = spawnSync(
  'node',
  [script, '--repo', fakeRepo, '--stamp', stamp, '--benchmark-summary-file', benchmarkSummaryPath, '--skip-gateway-status'],
  { encoding: 'utf8' },
);

assert.notEqual(run.status, 0, 'smoke should fail when runtime code mismatches repo');
const output = String(run.stdout || run.stderr || '').trim();
const jsonStart = output.indexOf('{');
const jsonEnd = output.lastIndexOf('}');
assert.ok(jsonStart >= 0 && jsonEnd >= jsonStart, 'smoke output should contain JSON object');
const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));

assert.equal(parsed.passed, false, 'smoke should report failed result');
assert.ok(Array.isArray(parsed.errors), 'errors array should exist');
assert.ok(parsed.errors.some((e) => /runtime code mismatch/i.test(String(e))), 'runtime mismatch should be explicitly surfaced');
console.log('live smoke failure visibility test passed');
