import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const script = path.join(repoRoot, 'scripts', 'run_memory_live_smoke.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-smoke-benchwarn-'));
const fakeRepo = path.join(tmpDir, 'fake-repo');
fs.mkdirSync(fakeRepo, { recursive: true });

const stamp = `test-smoke-benchwarn-${Date.now()}`;
const run = spawnSync('node', [script, '--repo', fakeRepo, '--stamp', stamp, '--skip-gateway-status'], { encoding: 'utf8' });

const output = String(run.stdout || run.stderr || '').trim();
const jsonStart = output.indexOf('{');
const jsonEnd = output.lastIndexOf('}');
assert.ok(jsonStart >= 0 && jsonEnd >= jsonStart, 'smoke output should contain JSON object');
const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));

assert.ok(Array.isArray(parsed.warnings), 'warnings should exist');
assert.ok(
  parsed.warnings.some((w) => /benchmark telemetry failed \(non-blocking\):/i.test(String(w))),
  'benchmark telemetry warning must stay visible',
);
assert.equal(parsed.benchmarkPassed, false, 'benchmark should remain marked as failed when telemetry command fails');
assert.ok(Array.isArray(parsed.errors), 'errors should exist');
assert.ok(parsed.errors.some((e) => /runtime code mismatch/i.test(String(e))), 'critical runtime mismatch must still fail smoke');
console.log('live smoke benchmark warning visibility test passed');
