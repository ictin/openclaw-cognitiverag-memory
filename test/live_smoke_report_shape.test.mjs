import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const script = path.join(repoRoot, 'scripts', 'run_memory_live_smoke.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-smoke-shape-'));
const benchmarkSummaryPath = path.join(tmpDir, 'benchmark-summary.json');
fs.writeFileSync(
  benchmarkSummaryPath,
  JSON.stringify({ passed: true, cases: [{ name: 'fixture_case', ok: true }] }, null, 2),
  'utf8',
);

const stamp = `test-smoke-shape-${Date.now()}`;
const run = spawnSync(
  'node',
  [script, '--repo', repoRoot, '--stamp', stamp, '--benchmark-summary-file', benchmarkSummaryPath, '--skip-gateway-status'],
  { encoding: 'utf8' },
);

const output = String(run.stdout || run.stderr || '').trim();
assert.ok(output.length > 0, 'smoke script should emit JSON output');
const jsonStart = output.indexOf('{');
const jsonEnd = output.lastIndexOf('}');
assert.ok(jsonStart >= 0 && jsonEnd >= jsonStart, 'smoke output should contain JSON object');
const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));

assert.equal(parsed.schemaVersion, 'live_smoke.v2');
assert.ok(parsed.runId, 'runId should exist');
assert.ok(parsed.startedAt, 'startedAt should exist');
assert.ok(parsed.finishedAt, 'finishedAt should exist');
assert.ok(typeof parsed.passed === 'boolean', 'passed must be boolean');
assert.ok(Array.isArray(parsed.cases), 'cases should be array');

assert.ok(parsed.runtimeProof && typeof parsed.runtimeProof === 'object', 'runtimeProof should be present');
assert.ok(typeof parsed.runtimeProof.runtimeEntryPath === 'string', 'runtimeEntryPath should be string');
assert.ok(typeof parsed.runtimeProof.runtimePluginRoot === 'string', 'runtimePluginRoot should be string');
assert.ok('repoGitSha' in parsed.runtimeProof, 'repoGitSha should be included');
assert.ok('runtimeCodeMatchesRepo' in parsed.runtimeProof, 'runtimeCodeMatchesRepo should be included');
assert.ok('runtimeCommitSha' in parsed.runtimeProof, 'runtimeCommitSha should be included');

const artifactPath = path.join(repoRoot, 'forensics', stamp, 'smoke', 'live_smoke_summary.json');
assert.ok(fs.existsSync(artifactPath), 'smoke summary artifact should exist');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
assert.equal(artifact.schemaVersion, 'live_smoke.v2');
assert.ok(artifact.runtimeProof?.runtimeEntryPath, 'artifact should contain runtime entry path');
assert.ok(artifact.runtimeProof?.runtimePluginRoot, 'artifact should contain runtime plugin root');
console.log('live smoke report shape test passed');
