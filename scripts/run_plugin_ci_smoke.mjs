#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';

function nowIso() {
  return new Date().toISOString();
}

function sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    repoRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    output: 'ci_artifacts/plugin_ci_smoke_summary.json',
    requireRuntime: false,
    requireRuntimePatch: false,
    requireGateway: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      out.repoRoot = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      out.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--require-runtime') {
      out.requireRuntime = true;
      continue;
    }
    if (arg === '--require-runtime-patch') {
      out.requireRuntimePatch = true;
      continue;
    }
    if (arg === '--require-gateway') {
      out.requireGateway = true;
      continue;
    }
  }
  return out;
}

function runtimeProof(repoRoot) {
  const runtimePluginRoot = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory';
  const runtimeEntryPath = path.join(runtimePluginRoot, 'index.ts');
  const runtimeIntentPath = path.join(runtimePluginRoot, 'src', 'bridge', 'intentDetector.ts');
  const repoEntryPath = path.join(repoRoot, 'index.ts');
  const repoIntentPath = path.join(repoRoot, 'src', 'bridge', 'intentDetector.ts');

  const runtimeEntryExists = fs.existsSync(runtimeEntryPath);
  const runtimeIntentExists = fs.existsSync(runtimeIntentPath);
  const runtimeAvailable = runtimeEntryExists && runtimeIntentExists;

  const runtimeEntryHash = sha256File(runtimeEntryPath);
  const runtimeIntentHash = sha256File(runtimeIntentPath);
  const repoEntryHash = sha256File(repoEntryPath);
  const repoIntentHash = sha256File(repoIntentPath);
  const runtimeCodeMatchesRepo =
    !!runtimeEntryHash &&
    !!runtimeIntentHash &&
    !!repoEntryHash &&
    !!repoIntentHash &&
    runtimeEntryHash === repoEntryHash &&
    runtimeIntentHash === repoIntentHash;

  return {
    runtimePluginRoot,
    runtimeEntryPath,
    runtimeIntentPath,
    repoEntryPath,
    repoIntentPath,
    runtimeAvailable,
    runtimeCodeMatchesRepo,
    runtimeEntryHash,
    runtimeIntentHash,
    repoEntryHash,
    repoIntentHash,
  };
}

function runRuntimePatchVerify(repoRoot) {
  const verifyScript = path.join(repoRoot, 'scripts', 'verify_openclaw_runtime_patch.mjs');
  if (!fs.existsSync(verifyScript)) {
    return { attempted: false, ok: false, reason: 'verify_script_missing' };
  }
  const proc = spawnSync(process.execPath, [verifyScript], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    attempted: true,
    ok: proc.status === 0,
    status: proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    runtimeMissing: /runtime file not found/i.test(`${proc.stdout || ''}\n${proc.stderr || ''}`),
  };
}

function runGatewayStatus(repoRoot) {
  try {
    const out = execFileSync('openclaw', ['gateway', 'call', 'status', '--params', '{}'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { attempted: true, ok: true, output: out };
  } catch (error) {
    return { attempted: true, ok: false, reason: String(error?.message || error) };
  }
}

const args = parseArgs(process.argv);
const repoGitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.repoRoot, encoding: 'utf8' }).trim();
const runtime = runtimeProof(args.repoRoot);
const runtimePatch = runRuntimePatchVerify(args.repoRoot);
const gateway = args.requireGateway ? runGatewayStatus(args.repoRoot) : { attempted: false, ok: null };

const errors = [];
const warnings = [];
if (args.requireRuntime && !runtime.runtimeAvailable) {
  errors.push('runtime_not_available');
}
if (runtime.runtimeAvailable && !runtime.runtimeCodeMatchesRepo && args.requireRuntime) {
  errors.push('runtime_code_mismatch');
} else if (runtime.runtimeAvailable && !runtime.runtimeCodeMatchesRepo) {
  warnings.push('runtime_code_mismatch_non_strict');
}
if (args.requireRuntimePatch && runtimePatch.attempted && !runtimePatch.ok && !runtimePatch.runtimeMissing) {
  errors.push('runtime_patch_verify_failed');
}
if (args.requireGateway && gateway.attempted && !gateway.ok) {
  errors.push('gateway_status_failed');
}

const summary = {
  schemaVersion: 'plugin_ci_smoke.v1',
  createdAt: nowIso(),
  repoRoot: args.repoRoot,
  repoGitSha,
  checks: {
    requireRuntime: args.requireRuntime,
    requireRuntimePatch: args.requireRuntimePatch,
    requireGateway: args.requireGateway,
  },
  runtimeProof: runtime,
  runtimePatchVerify: runtimePatch,
  gatewayStatus: gateway,
  warnings,
  passed: errors.length === 0,
  errors,
};

const outputPath = path.isAbsolute(args.output)
  ? args.output
  : path.join(args.repoRoot, args.output);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.passed ? 0 : 1);
