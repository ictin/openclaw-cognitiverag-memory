import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function parseArgs(argv) {
  const out = {
    repoRoot: '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory',
    stamp: `${nowStamp()}-live-smoke`,
    benchmarkSummaryFile: '',
    skipGatewayStatus: false,
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
    if (arg === '--benchmark-summary-file' && argv[i + 1]) {
      out.benchmarkSummaryFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--skip-gateway-status') {
      out.skipGatewayStatus = true;
      continue;
    }
  }
  return out;
}

function sha256File(filePath) {
  try {
    const data = fsSync.readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function buildRuntimeProof(repoRoot) {
  const runtimeEntryPath = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory/index.ts';
  const runtimePluginRoot = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory';
  const repoIndexPath = path.join(repoRoot, 'index.ts');
  const repoIntentPath = path.join(repoRoot, 'src', 'bridge', 'intentDetector.ts');
  const runtimeIntentPath = path.join(runtimePluginRoot, 'src', 'bridge', 'intentDetector.ts');

  const runtimeIndexHash = sha256File(runtimeEntryPath);
  const runtimeIntentHash = sha256File(runtimeIntentPath);
  const repoIndexHash = sha256File(repoIndexPath);
  const repoIntentHash = sha256File(repoIntentPath);
  const runtimeCodeMatchesRepo =
    !!runtimeIndexHash &&
    !!runtimeIntentHash &&
    !!repoIndexHash &&
    !!repoIntentHash &&
    runtimeIndexHash === repoIndexHash &&
    runtimeIntentHash === repoIntentHash;
  let repoGitSha = null;
  try {
    repoGitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    repoGitSha = null;
  }
  return {
    runtimeEntryPath,
    runtimePluginRoot,
    repoGitSha,
    runtimeCodeMatchesRepo,
    runtimeCommitSha: runtimeCodeMatchesRepo ? repoGitSha : null,
    runtimeIndexHash,
    runtimeIntentHash,
    repoIndexHash,
    repoIntentHash,
  };
}

const { repoRoot, stamp, benchmarkSummaryFile, skipGatewayStatus } = parseArgs(process.argv);
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
  schemaVersion: 'live_smoke.v2',
  runId: `${stamp}-${Date.now()}`,
  startedAt: new Date().toISOString(),
  repoRoot,
  stamp,
  forensicRoot,
  benchmarkSummaryPath,
  benchmarkPassed: false,
  cases: [],
  gatewayStatusPath,
  backendReachable: false,
  runtimeProof: buildRuntimeProof(repoRoot),
  errors: [],
};

try {
  let benchmarkSummary = null;
  if (benchmarkSummaryFile) {
    benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryFile, 'utf8'));
  } else {
    const benchRaw = execFileSync('node', [benchmarkScript, repoRoot, stamp], { encoding: 'utf8' });
    await fs.writeFile(benchmarkStdoutPath, benchRaw);
    benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryPath, 'utf8'));
  }
  smoke.benchmarkPassed = !!benchmarkSummary?.passed;
  smoke.cases = Array.isArray(benchmarkSummary?.cases)
    ? benchmarkSummary.cases.map((c) => ({ name: c?.name, ok: !!c?.ok }))
    : [];

  if (!skipGatewayStatus) {
    try {
      const statusRaw = execFileSync('openclaw', ['gateway', 'call', 'status', '--params', '{}'], { encoding: 'utf8' });
      await fs.writeFile(gatewayStatusPath, statusRaw);
      smoke.backendReachable = true;
    } catch (error) {
      smoke.errors.push(`gateway status capture failed: ${String(error?.message ?? error)}`);
    }
  }
} catch (error) {
  smoke.errors.push(String(error?.stack || error?.message || error));
}

smoke.finishedAt = new Date().toISOString();
if (smoke.runtimeProof?.runtimeCodeMatchesRepo === false) {
  smoke.errors.push('runtime code mismatch: runtimeCodeMatchesRepo=false');
}
smoke.passed = smoke.benchmarkPassed && smoke.errors.length === 0;
await fs.writeFile(smokeSummaryPath, JSON.stringify(smoke, null, 2));
await fs.appendFile(smokeLogPath, `${JSON.stringify(smoke)}\n`);

console.log(JSON.stringify(smoke, null, 2));
process.exit(smoke.passed ? 0 : 1);
