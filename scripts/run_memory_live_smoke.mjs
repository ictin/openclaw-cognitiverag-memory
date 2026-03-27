import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseArgs(argv) {
  const out = {
    repoRoot: '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory',
    stamp: `${nowStamp()}-live-smoke`,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      out.repoRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--stamp' && argv[i + 1]) {
      out.stamp = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return out;
}

const { repoRoot, stamp } = parseArgs(process.argv);
const forensicRoot = path.join(repoRoot, 'forensics', stamp);
const smokeDir = path.join(forensicRoot, 'smoke');
const logsDir = path.join(forensicRoot, 'logs');

fsSync.mkdirSync(smokeDir, { recursive: true });
fsSync.mkdirSync(logsDir, { recursive: true });

const benchmarkScript = path.join(repoRoot, 'scripts', 'run_memory_quality_benchmark.mjs');
const benchmarkStdoutPath = path.join(smokeDir, 'benchmark_stdout.json');
const benchmarkSummaryPath = path.join(forensicRoot, 'bench', 'memory_quality_benchmark_summary.json');
const smokeSummaryPath = path.join(smokeDir, 'live_smoke_summary.json');
const gatewayStatusPath = path.join(smokeDir, 'gateway_status_after_smoke.json');
const smokeLogPath = path.join(logsDir, 'live_smoke.log');

const smoke = {
  startedAt: new Date().toISOString(),
  repoRoot,
  stamp,
  forensicRoot,
  benchmarkSummaryPath,
  benchmarkPassed: false,
  cases: [],
  gatewayStatusPath,
  errors: [],
};

try {
  const benchRaw = execFileSync('node', [benchmarkScript, repoRoot, stamp], { encoding: 'utf8' });
  await fs.writeFile(benchmarkStdoutPath, benchRaw);

  const benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryPath, 'utf8'));
  smoke.benchmarkPassed = !!benchmarkSummary?.passed;
  smoke.cases = Array.isArray(benchmarkSummary?.cases)
    ? benchmarkSummary.cases.map((c) => ({ name: c?.name, ok: !!c?.ok }))
    : [];

  try {
    const statusRaw = execFileSync('openclaw', ['gateway', 'call', 'status', '--params', '{}'], { encoding: 'utf8' });
    await fs.writeFile(gatewayStatusPath, statusRaw);
  } catch (error) {
    smoke.errors.push(`gateway status capture failed: ${String(error?.message ?? error)}`);
  }
} catch (error) {
  smoke.errors.push(String(error?.stack || error?.message || error));
}

smoke.finishedAt = new Date().toISOString();
smoke.passed = smoke.benchmarkPassed && smoke.errors.length === 0;
await fs.writeFile(smokeSummaryPath, JSON.stringify(smoke, null, 2));
await fs.appendFile(smokeLogPath, `${JSON.stringify(smoke)}\n`);

console.log(JSON.stringify(smoke, null, 2));
process.exit(smoke.passed ? 0 : 1);
