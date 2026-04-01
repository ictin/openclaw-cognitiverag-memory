import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const REPORTS_ROOT = path.join(REPO_ROOT, 'forensics', 'live_acceptance_reports');
const CRITICAL = new Set(['T0.1', 'T0.2', 'T4.1', 'T5.1', 'T6.1', 'T7.1', 'T8.1', 'T9.1', 'T12.2', 'T14.1', 'T14.2']);
const GROUP_BATCHES = [
  ['G0', 'G1', 'G2', 'G3'],
  ['G4', 'G5'],
  ['G6', 'G7', 'G8', 'G9'],
  ['G10', 'G11', 'G12'],
  ['G13', 'G14', 'G15'],
];
const RUNTIME_ENTRY_PATH = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory/index.ts';
const RUNTIME_PLUGIN_ROOT = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory';
const SKIP_MONOLITHIC = /^(1|true|yes)$/i.test(String(process.env.LIVE_ACCEPTANCE_SKIP_MONOLITHIC || '0'));
const MONOLITHIC_TIMEOUT_SEC = Math.max(60, Number(process.env.LIVE_ACCEPTANCE_MONOLITHIC_TIMEOUT_SEC || (12 * 60)));
const GROUP_TIMEOUT_SEC = Math.max(60, Number(process.env.LIVE_ACCEPTANCE_GROUP_TIMEOUT_SEC || (16 * 60)));

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function runAcceptance(scriptPath, args = [], envExtra = {}, timeoutSec = 1800) {
  const envPrefix = Object.entries(envExtra)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ');
  const cmdParts = [
    'timeout',
    '--signal=KILL',
    `${Math.max(1, Number(timeoutSec))}s`,
    'node',
    shellQuote(scriptPath),
    ...args.map((a) => shellQuote(a)),
  ];
  const cmd = `${envPrefix ? `${envPrefix} ` : ''}${cmdParts.join(' ')}`;
  try {
    const stdout = execFileSync('bash', ['-lc', cmd], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    return {
      stdout: String(error?.stdout || ''),
      status: Number(error?.status ?? 1),
      error: String(error?.message || error),
    };
  }
}

function parseRunJson(stdout) {
  const trimmed = String(stdout || '').trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Unable to parse run JSON output');
  return JSON.parse(trimmed.slice(first, last + 1));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function buildRuntimeProofFallback(gitSha) {
  const repoIndexPath = path.join(REPO_ROOT, 'index.ts');
  const repoIntentPath = path.join(REPO_ROOT, 'src', 'bridge', 'intentDetector.ts');
  const runtimeIntentPath = path.join(RUNTIME_PLUGIN_ROOT, 'src', 'bridge', 'intentDetector.ts');
  const runtimeIndexHash = sha256File(RUNTIME_ENTRY_PATH);
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
  return {
    runtimeEntryPath: RUNTIME_ENTRY_PATH,
    runtimePluginRoot: RUNTIME_PLUGIN_ROOT,
    repoGitSha: gitSha,
    runtimeCodeMatchesRepo,
    runtimeCommitSha: runtimeCodeMatchesRepo ? gitSha : null,
    runtimeIndexHash,
    runtimeIntentHash,
    repoIndexHash,
    repoIntentHash,
    extractedFrom: 'closure-fallback',
  };
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function renderFinalMarkdown(summary) {
  const lines = [];
  lines.push('# Final Live Acceptance Closure Report');
  lines.push('');
  lines.push(`- schema version: ${summary.schemaVersion}`);
  lines.push(`- stamp: ${summary.stamp}`);
  lines.push(`- closure mode: ${summary.closureMode}`);
  lines.push(`- monolithic attempted: ${summary.monolithicAttempted ? 'yes' : 'no'}`);
  lines.push(`- monolithic succeeded: ${summary.monolithicSucceeded ? 'yes' : 'no'}`);
  lines.push(`- total score: ${summary.totalScore}/${summary.totalMax}`);
  lines.push(`- critical hard fails: ${summary.criticalFailures.length}`);
  lines.push(`- git sha: ${summary.codeState?.gitSha || 'unknown'}`);
  lines.push(`- runtime commit sha: ${summary.runtimeProof?.runtimeCommitSha || 'unknown'}`);
  lines.push(`- runtime entry path: ${summary.runtimeProof?.runtimeEntryPath || 'unknown'}`);
  lines.push(`- runtime plugin root: ${summary.runtimeProof?.runtimePluginRoot || 'unknown'}`);
  lines.push(`- runtime code matches repo: ${summary.runtimeProof?.runtimeCodeMatchesRepo ? 'yes' : 'no'}`);
  lines.push(`- groups run: ${(summary.groupsRun || []).join(', ') || 'none'}`);
  lines.push(`- model routes used: ${(summary.modelRoutesUsed || []).join(', ') || 'none'}`);
  lines.push(`- final verdict: ${summary.finalVerdict}`);
  lines.push('');
  lines.push('## Group Runs');
  lines.push('');
  lines.push('| Batch | Groups | Stamp | Score | Max | Critical Fails |');
  lines.push('|---|---|---|---:|---:|---:|');
  for (const run of summary.groupRuns) {
    lines.push(`| ${run.batchId} | ${run.groups.join(',')} | ${run.stamp} | ${run.totalScore} | ${run.totalMax} | ${run.criticalHardFailCount} |`);
  }
  lines.push('');
  lines.push('## Group Summary');
  lines.push('');
  lines.push('| Group | Score | Max | Fails |');
  lines.push('|---|---:|---:|---:|');
  for (const g of summary.groups) {
    lines.push(`| ${g.id} ${g.title} | ${g.score} | ${g.max} | ${g.fails} |`);
  }
  lines.push('');
  lines.push('## Critical Failures');
  lines.push('');
  if (!summary.criticalFailures.length) {
    lines.push('- none');
  } else {
    for (const f of summary.criticalFailures) lines.push(`- ${f.id}: ${f.reason}`);
  }
  lines.push('');
  lines.push('## Final Signoff');
  lines.push('');
  lines.push(`- verdict: ${summary.criticalFailures.length ? 'NOT READY' : 'READY'}`);
  lines.push(`- rationale: ${summary.criticalFailures.length ? 'one or more critical tests still hard-failing' : 'all critical tests passed in grouped closure under same code state'}`);
  return lines.join('\n');
}

function main() {
  ensureDir(REPORTS_ROOT);
  const closureStamp = process.argv[2] || `${nowStamp()}-live-acceptance-final-closure`;
  const closureDir = path.join(REPORTS_ROOT, closureStamp);
  ensureDir(closureDir);

  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();

  const monolithic = {
    attempted: false,
    succeeded: false,
    error: '',
    stamp: '',
    reportDir: '',
  };

  // Step A: monolithic attempt (optional)
  if (!SKIP_MONOLITHIC) {
    try {
      monolithic.attempted = true;
      const monoStamp = `${nowStamp()}-live-acceptance-monolithic-closure`;
      const monoRun = runAcceptance(path.join(REPO_ROOT, 'scripts', 'run_live_agent_acceptance.mjs'), [monoStamp], {}, MONOLITHIC_TIMEOUT_SEC);
      const parsed = parseRunJson(monoRun.stdout);
      monolithic.stamp = parsed.stamp || monoStamp;
      monolithic.reportDir = parsed.reportDir || path.join(REPORTS_ROOT, monolithic.stamp);
      monolithic.succeeded = Number(parsed.criticalHardFailCount || 0) === 0;
    } catch (error) {
      monolithic.attempted = true;
      monolithic.succeeded = false;
      monolithic.error = String(error?.message || error);
    }
  }

  if (monolithic.succeeded) {
    const monoResults = loadJson(path.join(monolithic.reportDir, 'live_acceptance_results.json'));
    const finalSummary = {
      schemaVersion: 'live_acceptance_closure.v2',
      stamp: closureStamp,
      generatedAt: new Date().toISOString(),
      closureMode: 'monolithic',
      monolithicAttempted: true,
      monolithicSucceeded: true,
      monolithic,
      codeState: { gitSha },
      groupRuns: [
        {
          batchId: 'MONO',
          groups: ['ALL'],
          stamp: monoResults.stamp,
          reportDir: monolithic.reportDir,
          totalScore: monoResults.totalScore,
          totalMax: monoResults.totalMax,
          criticalHardFailCount: monoResults.criticalFailures?.length || 0,
        },
      ],
      totalScore: monoResults.totalScore,
      totalMax: monoResults.totalMax,
      criticalFailures: monoResults.criticalFailures || [],
      groups: monoResults.groups || [],
      tests: monoResults.tests || [],
      groupsRun: monoResults.groupsRun || (monoResults.groups || []).map((g) => g.id),
      modelRoutesUsed: monoResults.modelRoutesUsed || [],
      runtimeProof: monoResults.runtimeProof || null,
      finalVerdict: (monoResults.criticalFailures || []).length ? 'NOT READY' : 'READY',
    };
    fs.writeFileSync(path.join(closureDir, 'final_live_acceptance_results.json'), JSON.stringify(finalSummary, null, 2));
    fs.writeFileSync(path.join(closureDir, 'final_live_acceptance_report.md'), renderFinalMarkdown(finalSummary));
    fs.writeFileSync(path.join(REPO_ROOT, 'forensics', '.latest_live_acceptance_report'), `${closureDir}\n`);
    console.log(JSON.stringify({ stamp: closureStamp, closureMode: 'monolithic', reportDir: closureDir, criticalHardFailCount: finalSummary.criticalFailures.length }, null, 2));
    if (finalSummary.criticalFailures.length > 0) process.exitCode = 2;
    return;
  }

  // Step B: grouped resumable closure
  const groupRuns = [];
  const aggregatedTests = [];
  const runtimeProofCandidates = [];

  for (let i = 0; i < GROUP_BATCHES.length; i += 1) {
    const groups = GROUP_BATCHES[i];
    const batchId = `B${i + 1}`;
    const batchStamp = `${nowStamp()}-live-acceptance-${batchId}`;
    const envExtra = { LIVE_ACCEPTANCE_GROUPS: groups.join(',') };
    const batchRun = runAcceptance(path.join(REPO_ROOT, 'scripts', 'run_live_agent_acceptance.mjs'), [batchStamp], envExtra, GROUP_TIMEOUT_SEC);
    const parsed = parseRunJson(batchRun.stdout);
    const reportDir = parsed.reportDir || path.join(REPORTS_ROOT, parsed.stamp || batchStamp);
    const resultJson = loadJson(path.join(reportDir, 'live_acceptance_results.json'));

    const runGitSha = String(resultJson?.codeState?.gitSha || '');
    if (runGitSha && runGitSha !== gitSha) {
      throw new Error(`Code state drift detected in ${batchId}: expected ${gitSha} got ${runGitSha}`);
    }

    groupRuns.push({
      batchId,
      groups,
      stamp: resultJson.stamp,
      reportDir,
      totalScore: resultJson.totalScore,
      totalMax: resultJson.totalMax,
      criticalHardFailCount: resultJson.criticalFailures?.length || 0,
      modelRoutesUsed: resultJson.modelRoutesUsed || [],
      runtimeEntryPath: resultJson.runtimeProof?.runtimeEntryPath || null,
      runtimePluginRoot: resultJson.runtimeProof?.runtimePluginRoot || null,
    });
    if (resultJson.runtimeProof) runtimeProofCandidates.push(resultJson.runtimeProof);

    for (const t of resultJson.tests || []) aggregatedTests.push(t);
  }

  const groupMap = groupBy(aggregatedTests, (t) => t.group);
  const groups = Array.from(groupMap.entries()).map(([groupId, arr]) => ({
    id: groupId,
    title: String(arr[0]?.groupTitle || groupId),
    score: arr.reduce((n, t) => n + Number(t.score || 0), 0),
    max: arr.length * 2,
    fails: arr.filter((t) => Number(t.score || 0) === 0).length,
  })).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const criticalFailures = aggregatedTests
    .filter((t) => CRITICAL.has(String(t.id || '')) && Number(t.score || 0) === 0)
    .map((t) => ({ id: t.id, reason: t.reason }));

  const totalScore = aggregatedTests.reduce((n, t) => n + Number(t.score || 0), 0);
  const totalMax = aggregatedTests.length * 2;
  const modelRoutesUsed = Array.from(new Set(aggregatedTests.map((t) => String(t.modelRoute || 'weak/default')))).sort();
  const groupsRun = groups.map((g) => g.id);
  const runtimeProofFromRuns =
    runtimeProofCandidates.find((p) => p?.runtimeCodeMatchesRepo) ||
    runtimeProofCandidates[0] ||
    null;
  const runtimeProof = runtimeProofFromRuns || buildRuntimeProofFallback(gitSha);

  const finalSummary = {
    schemaVersion: 'live_acceptance_closure.v2',
    stamp: closureStamp,
    generatedAt: new Date().toISOString(),
    closureMode: 'grouped_resumable',
    monolithicAttempted: monolithic.attempted,
    monolithicSucceeded: monolithic.succeeded,
    monolithic,
    codeState: { gitSha },
    groupRuns,
    totalScore,
    totalMax,
    criticalFailures,
    groups,
    tests: aggregatedTests,
    groupsRun,
    modelRoutesUsed,
    runtimeProof,
    finalVerdict: criticalFailures.length ? 'NOT READY' : 'READY',
  };

  fs.writeFileSync(path.join(closureDir, 'final_live_acceptance_results.json'), JSON.stringify(finalSummary, null, 2));
  fs.writeFileSync(path.join(closureDir, 'final_live_acceptance_report.md'), renderFinalMarkdown(finalSummary));
  fs.writeFileSync(path.join(REPO_ROOT, 'forensics', '.latest_live_acceptance_report'), `${closureDir}\n`);

  console.log(JSON.stringify({
    stamp: closureStamp,
    closureMode: finalSummary.closureMode,
    monolithicAttempted: monolithic.attempted,
    monolithicSucceeded: monolithic.succeeded,
    reportDir: closureDir,
    totalScore,
    totalMax,
    criticalHardFailCount: criticalFailures.length,
    criticalHardFails: criticalFailures,
  }, null, 2));

  if (criticalFailures.length > 0) process.exitCode = 2;
}

main();
