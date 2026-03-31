import fs from 'node:fs';
import path from 'node:path';

const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const latestPtr = path.join(repoRoot, 'forensics', '.latest_live_acceptance_report');
const arg = process.argv[2] || '';

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let reportDir = '';
if (arg) {
  reportDir = path.isAbsolute(arg) ? arg : path.join(repoRoot, 'forensics', 'live_acceptance_reports', arg);
} else if (fs.existsSync(latestPtr)) {
  reportDir = fs.readFileSync(latestPtr, 'utf8').trim();
}

if (!reportDir) {
  console.error('No live acceptance report directory found. Run scripts/run_live_agent_acceptance.mjs first.');
  process.exit(1);
}

const jsonFile = path.join(reportDir, 'live_acceptance_results.json');
if (!fs.existsSync(jsonFile)) {
  console.error(`Missing results file: ${jsonFile}`);
  process.exit(1);
}

const results = load(jsonFile);
const criticalHardFails = Array.isArray(results?.criticalFailures) ? results.criticalFailures : [];
const groups = Array.isArray(results?.groups) ? results.groups : [];

console.log(JSON.stringify({
  reportDir,
  totalScore: results.totalScore,
  totalMax: results.totalMax,
  criticalHardFailCount: criticalHardFails.length,
  criticalHardFails,
  groups,
}, null, 2));

if (criticalHardFails.length > 0) process.exitCode = 2;
