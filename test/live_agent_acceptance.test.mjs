import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const runner = path.join(repoRoot, 'scripts', 'run_live_agent_acceptance.mjs');
const scorer = path.join(repoRoot, 'scripts', 'score_live_agent_acceptance.mjs');

assert.ok(fs.existsSync(runner), 'live acceptance runner should exist');
assert.ok(fs.existsSync(scorer), 'live acceptance scorer should exist');

execFileSync('node', ['--check', runner], { stdio: 'pipe' });
execFileSync('node', ['--check', scorer], { stdio: 'pipe' });

const text = fs.readFileSync(runner, 'utf8');
for (const id of ['T0.1', 'T0.2', 'T4.1', 'T5.1', 'T6.1', 'T7.1', 'T8.1', 'T9.1', 'T12.2', 'T14.1', 'T14.2']) {
  assert.match(text, new RegExp(id.replace('.', '\\.'), 'i'), `critical id ${id} should be present in runner`);
}

console.log('live agent acceptance harness test passed');
