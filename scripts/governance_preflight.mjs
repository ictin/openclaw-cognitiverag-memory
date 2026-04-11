#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const requiredFiles = [
  'docs/governance/implementation_constitution.md',
  'docs/governance/closure_checklist.md',
  'docs/governance/README.md',
  'docs/governance/templates/backend_implementation_story_template.md',
  'docs/governance/templates/plugin_runtime_integration_story_template.md',
  'docs/governance/templates/live_closure_signoff_template.md',
  'docs/governance/templates/backend_audit_story_template.md',
  'docs/governance/templates/audit_reconciliation_story_template.md',
];

const requiredPhrases = [
  { file: 'docs/governance/implementation_constitution.md', phrase: 'Backend owns intelligence' },
  { file: 'docs/governance/implementation_constitution.md', phrase: 'Plugin owns OpenClaw integration' },
  { file: 'docs/governance/implementation_constitution.md', phrase: 'Do not call signoff from partial reruns alone' },
  { file: 'docs/governance/closure_checklist.md', phrase: 'final closure artifacts exist' },
];

const errors = [];
for (const rel of requiredFiles) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) errors.push(`missing_file:${rel}`);
}
for (const item of requiredPhrases) {
  const full = path.join(repoRoot, item.file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  if (!text.includes(item.phrase)) errors.push(`missing_phrase:${item.file}:${item.phrase}`);
}

const out = {
  schemaVersion: 'governance_preflight.v1',
  repoRoot,
  checkedFiles: requiredFiles,
  checkedPhrases: requiredPhrases,
  passed: errors.length === 0,
  errors,
};

console.log(JSON.stringify(out, null, 2));
process.exit(out.passed ? 0 : 1);
