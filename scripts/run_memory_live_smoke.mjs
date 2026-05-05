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

function parseGatewayJson(raw) {
  const idx = raw.indexOf('{');
  if (idx < 0) throw new Error('No JSON payload in gateway output');
  return JSON.parse(raw.slice(idx));
}

function callGateway(method, params, options = {}) {
  const { retries = 3, backoffMs = 1200 } = options;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const raw = execFileSync('openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params)], {
        encoding: 'utf8',
      });
      return { ok: true, raw, parsed: parseGatewayJson(raw), attempt };
    } catch (error) {
      const msg = String(error?.message ?? error ?? '');
      const retryable =
        msg.includes('gateway closed') ||
        msg.includes('abnormal closure') ||
        msg.includes('no close reason') ||
        msg.includes('gateway timeout') ||
        msg.includes('timeout after') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED');
      if (!retryable || attempt === retries) {
        return { ok: false, error: msg, attempt };
      }
      execSync(`sleep ${Math.min(12, (attempt * backoffMs) / 1000)}`, { stdio: 'pipe', shell: '/bin/bash' });
    }
  }
  return { ok: false, error: 'gateway call failed with no result', attempt: retries };
}

function textOfMessage(msg) {
  const content = msg?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return typeof content === 'string' ? content : '';
}

function runRuntimeBaselineSmoke(smokeDir) {
  const transcriptPath = path.join(smokeDir, 'runtime_baseline_transcript.json');
  const calls = [];
  const key = `agent:main:live-smoke-baseline-${Date.now()}`;

  const created = callGateway('sessions.create', { key, label: `Live smoke baseline ${Date.now()}` }, { retries: 4 });
  calls.push({ method: 'sessions.create', ok: created.ok, attempt: created.attempt, error: created.error ?? null });
  if (!created.ok) {
    return {
      passed: false,
      reason: 'baseline_session_create_failed',
      calls,
      transcriptPath: null,
    };
  }

  const sentStatus = callGateway('sessions.send', { key, message: '/crag_status' }, { retries: 4 });
  calls.push({ method: 'sessions.send:/crag_status', ok: sentStatus.ok, attempt: sentStatus.attempt, error: sentStatus.error ?? null });

  const sentExplain = callGateway('sessions.send', { key, message: '/crag_explain_memory' }, { retries: 4 });
  calls.push({
    method: 'sessions.send:/crag_explain_memory',
    ok: sentExplain.ok,
    attempt: sentExplain.attempt,
    error: sentExplain.error ?? null,
  });

  let lastParsed = null;
  let statusOk = false;
  let explainOk = false;
  const maxPoll = 30;
  for (let poll = 1; poll <= maxPoll; poll += 1) {
    const got = callGateway('sessions.get', { key }, { retries: 4 });
    calls.push({
      method: 'sessions.get',
      poll,
      ok: got.ok,
      attempt: got.attempt,
      error: got.error ?? null,
    });
    if (got.ok) {
      lastParsed = got.parsed;
      const messages = Array.isArray(got.parsed?.messages) ? got.parsed.messages : [];
      const allText = messages.map(textOfMessage).join('\n');
      statusOk = /CognitiveRAG Status/i.test(allText) && /runtime entry path:/i.test(allText);
      explainOk = /CognitiveRAG Memory Architecture/i.test(allText) && /backend ownership:/i.test(allText);
      if (statusOk && explainOk) break;
    }
    execSync('sleep 1', { stdio: 'pipe', shell: '/bin/bash' });
  }

  const messages = Array.isArray(lastParsed?.messages) ? lastParsed.messages : [];
  const baseline = {
    passed: statusOk && explainOk,
    statusOk,
    explainOk,
    reason: statusOk && explainOk ? 'ok' : 'baseline_surface_missing',
    calls,
    messageCount: messages.length,
  };
  fsSync.writeFileSync(transcriptPath, JSON.stringify({ baseline, session: lastParsed ?? {} }, null, 2));
  baseline.transcriptPath = transcriptPath;
  return baseline;
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
  benchmarkRole: 'stress_telemetry_non_blocking',
  cases: [],
  baselineChecks: {
    passed: false,
    statusOk: false,
    explainOk: false,
    reason: 'not_run',
    transcriptPath: null,
  },
  gatewayStatusPath,
  backendReachable: false,
  runtimeProof: buildRuntimeProof(repoRoot),
  errors: [],
  warnings: [],
};

function compactErrorMessage(text, maxLines = 16) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return lines.slice(0, maxLines).join('\n');
}

try {
  let benchmarkSummary = null;
  if (benchmarkSummaryFile) {
    benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryFile, 'utf8'));
  } else {
    try {
      const benchRaw = execFileSync('node', [benchmarkScript, repoRoot, stamp], { encoding: 'utf8' });
      await fs.writeFile(benchmarkStdoutPath, benchRaw);
      benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryPath, 'utf8'));
    } catch (error) {
      // Benchmark can exit non-zero for failed benchmark cases while still writing
      // a valid summary artifact. Preserve that structure for truthful classification.
      try {
        benchmarkSummary = JSON.parse(await fs.readFile(benchmarkSummaryPath, 'utf8'));
      } catch {
        benchmarkSummary = null;
      }
      if (benchmarkSummary && Array.isArray(benchmarkSummary.cases)) {
        const failedCases = benchmarkSummary.cases.filter((c) => !c?.ok).map((c) => c?.name).filter(Boolean);
        smoke.warnings.push(
          `benchmark telemetry failed (non-blocking): benchmark_summary_passed=false; failed_cases=${failedCases.join(',') || 'unknown'}`,
        );
      } else {
        smoke.warnings.push(
          `benchmark telemetry failed (non-blocking): ${compactErrorMessage(String(error?.message ?? error))}`,
        );
      }
    }
  }
  smoke.benchmarkPassed = !!benchmarkSummary?.passed;
  smoke.cases = Array.isArray(benchmarkSummary?.cases) ? benchmarkSummary.cases.map((c) => ({ name: c?.name, ok: !!c?.ok })) : [];

  const shouldRunBaseline = !benchmarkSummaryFile;
  if (shouldRunBaseline) {
    const baseline = runRuntimeBaselineSmoke(smokeDir);
    smoke.baselineChecks = baseline;
    smoke.backendReachable = !!baseline.passed;
  } else {
    smoke.baselineChecks = {
      passed: true,
      statusOk: true,
      explainOk: true,
      reason: 'fixture_mode_skipped',
      transcriptPath: null,
    };
  }

  if (!skipGatewayStatus) {
    try {
      const statusRaw = execFileSync('openclaw', ['gateway', 'call', 'status', '--params', '{}'], { encoding: 'utf8' });
      await fs.writeFile(gatewayStatusPath, statusRaw);
    } catch (error) {
      smoke.warnings.push(`gateway status capture failed: ${String(error?.message ?? error)}`);
    }
  }
} catch (error) {
  smoke.errors.push(String(error?.stack || error?.message || error));
}

smoke.finishedAt = new Date().toISOString();
if (smoke.runtimeProof?.runtimeCodeMatchesRepo === false) {
  smoke.errors.push('runtime code mismatch: runtimeCodeMatchesRepo=false');
}
if (!smoke.baselineChecks?.passed) {
  smoke.errors.push(`runtime baseline checks failed: ${smoke.baselineChecks?.reason ?? 'unknown'}`);
}
smoke.passed = smoke.errors.length === 0;
await fs.writeFile(smokeSummaryPath, JSON.stringify(smoke, null, 2));
await fs.appendFile(smokeLogPath, `${JSON.stringify(smoke)}\n`);

console.log(JSON.stringify(smoke, null, 2));
process.exit(smoke.passed ? 0 : 1);
