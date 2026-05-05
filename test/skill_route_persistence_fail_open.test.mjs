import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = '/tmp/openclaw-cognitiverag-memory-f012-merge';
const indexFile = path.join(repoRoot, 'index.ts');
const text = fs.readFileSync(indexFile, 'utf8');

assert.match(
  text,
  /No recent skill-guided execution is available to score yet\./,
  'skill evaluation must fail closed with explicit no-recent-run message',
);
assert.match(
  text,
  /sourceBasis:\s*\['no_recent_skill_run_for_evaluation'\]/,
  'skill evaluation no-recent path must expose explicit source basis marker',
);
assert.match(
  text,
  /Execution memory write: unavailable\./,
  'skill generation path must explicitly surface unavailable execution-memory writes',
);
assert.match(
  text,
  /Evaluation memory write: unavailable\./,
  'skill evaluation path must explicitly surface unavailable evaluation-memory writes',
);
assert.match(
  text,
  /if \(qLower\.includes\('did you store an evaluation case for that'\)\)/,
  'skill evaluation follow-up path must preserve evaluation write/readback check route',
);

console.log('skill route persistence fail-open regression passed');
