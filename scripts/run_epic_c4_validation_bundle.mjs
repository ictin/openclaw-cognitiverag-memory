#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseArgs(argv) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const stamp = `${nowStamp()}-epic-c4-validation`;
  const out = {
    repoRoot,
    stamp,
    outputDir: path.join(repoRoot, 'forensics', stamp, 'c4_validation'),
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      out.repoRoot = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output-dir' && argv[i + 1]) {
      out.outputDir = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

function runStep(repoRoot, label, cmd, args) {
  const startedAt = new Date().toISOString();
  const proc = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
  const finishedAt = new Date().toISOString();
  return {
    label,
    command: [cmd, ...args].join(' '),
    startedAt,
    finishedAt,
    ok: proc.status === 0,
    status: proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
  };
}

const { repoRoot, outputDir, dryRun } = parseArgs(process.argv);
const steps = [
  { label: 'assemble_tests', cmd: 'npm', args: ['run', 'test:assemble'] },
  { label: 'registration_tests', cmd: 'npm', args: ['run', 'test:registration'] },
  { label: 'plugin_test_wall', cmd: 'npm', args: ['test'] },
  { label: 'ci_smoke_wrapper', cmd: 'node', args: ['scripts/run_plugin_ci_smoke.mjs', '--output', 'ci_artifacts/plugin_ci_smoke_summary.json'] },
];

const startedAt = new Date().toISOString();
const results = [];
for (const step of steps) {
  if (dryRun) {
    results.push({
      label: step.label,
      command: [step.cmd, ...step.args].join(' '),
      dryRun: true,
      ok: true,
      status: 0,
      stdout: '',
      stderr: '',
    });
    continue;
  }
  const result = runStep(repoRoot, step.label, step.cmd, step.args);
  results.push(result);
  if (!result.ok) break;
}
const finishedAt = new Date().toISOString();

const summary = {
  schemaVersion: 'epic_c4_validation_bundle.v1',
  startedAt,
  finishedAt,
  repoRoot,
  dryRun,
  steps: results,
  passed: results.every((r) => r.ok),
};

fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, 'epic_c4_validation_summary.json');
fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

const lines = [
  '# Epic C4 Validation Bundle',
  '',
  `- started_at: \`${startedAt}\``,
  `- finished_at: \`${finishedAt}\``,
  `- dry_run: \`${dryRun ? 'yes' : 'no'}\``,
  `- passed: \`${summary.passed ? 'yes' : 'no'}\``,
  '',
  '## Steps',
];
for (const step of results) {
  lines.push(`- ${step.label}: \`${step.ok ? 'pass' : 'fail'}\` (${step.command})`);
}
const mdPath = path.join(outputDir, 'epic_c4_validation_summary.md');
fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);

console.log(JSON.stringify({ passed: summary.passed, jsonPath, mdPath }, null, 2));
process.exit(summary.passed ? 0 : 1);
