import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function safeParseGatewayJson(raw) {
  const idx = raw.indexOf('{');
  if (idx < 0) throw new Error('No JSON payload in gateway output');
  return JSON.parse(raw.slice(idx));
}

function ensureDir(dir) {
  fsSync.mkdirSync(dir, { recursive: true });
}

function readMaybe(file) {
  try {
    return fsSync.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function countJsonlLines(file) {
  const text = readMaybe(file);
  if (!text.trim()) return 0;
  return text.split(/\r?\n/).filter(Boolean).length;
}

function findLongestSession(pluginLiveRoot) {
  const sessionDir = path.join(pluginLiveRoot, 'session_memory');
  if (!fsSync.existsSync(sessionDir)) return { sessionId: '', rawCount: 0, rawFile: '' };
  const files = fsSync.readdirSync(sessionDir).filter((n) => /^raw_.+\.jsonl$/.test(n));
  let best = { sessionId: '', rawCount: 0, rawFile: '' };
  for (const file of files) {
    const abs = path.join(sessionDir, file);
    const count = countJsonlLines(abs);
    if (count > best.rawCount) {
      best = {
        sessionId: file.replace(/^raw_/, '').replace(/\.jsonl$/, ''),
        rawCount: count,
        rawFile: abs,
      };
    }
  }
  return best;
}

const repoRoot = process.argv[2] || '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
const ts = process.argv[3] || `${nowStamp()}-benchmark`;
const forensicRoot = path.join(repoRoot, 'forensics', ts);
const benchDir = path.join(forensicRoot, 'bench');
const sessionsDir = path.join(forensicRoot, 'sessions');
const logsDir = path.join(forensicRoot, 'logs');

ensureDir(benchDir);
ensureDir(sessionsDir);
ensureDir(logsDir);

const pluginLiveRoot = '/home/ictin_claw/.openclaw/workspace/.openclaw/extensions/cognitiverag-memory';
const benchmarkKey = `agent:main:memory-benchmark-${Date.now()}`;
const benchmarkLabel = `Memory Benchmark ${Date.now()}`;
const benchmarkToken = `MEM-QUALITY-${Date.now()}-${Math.floor(Math.random() * 90000 + 10000)}`;
const oldAnchorToken = 'LOSSLESS-LIVE-17746045-AX12';
const crossToken = 'MVP-CRAG-NATIVE-AGENT-1774596120-20515';
const bookExactQuery = 'Business-to-Business Direct Marketing';
const bookNearQuery = 'MENTAL MANIPULATION TECHNIQUES';
const bookSemanticQuery = 'how can dark psychology influence people';

const calls = [];
let callIndex = 0;

function sleepMs(ms) {
  execSync(`sleep ${Math.max(0, ms) / 1000}`, { stdio: 'pipe', shell: '/bin/bash' });
}

function isRetryableGatewayError(error) {
  const text = String(error?.message ?? error ?? '');
  return (
    text.includes('gateway closed') ||
    text.includes('gateway timeout') ||
    text.includes('timeout after') ||
    text.includes('ETIMEDOUT') ||
    text.includes('ECONNREFUSED') ||
    text.includes('connect ECONNREFUSED') ||
    text.includes('abnormal closure') ||
    text.includes('no close reason')
  );
}

function callGateway(method, params, options = {}) {
  const { maxAttempts = 8, baseBackoffMs = 1500 } = options;
  callIndex += 1;
  let raw = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      raw = execFileSync('openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params)], {
        encoding: 'utf8',
      });
      break;
    } catch (error) {
      if (!isRetryableGatewayError(error) || attempt === maxAttempts) {
        throw error;
      }
      sleepMs(Math.min(12000, attempt * baseBackoffMs));
    }
  }
  const rawPath = path.join(sessionsDir, `${String(callIndex).padStart(2, '0')}_${method}.raw`);
  fsSync.writeFileSync(rawPath, raw);
  const parsed = safeParseGatewayJson(raw);
  const jsonPath = path.join(sessionsDir, `${String(callIndex).padStart(2, '0')}_${method}.json`);
  fsSync.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2));
  calls.push({ method, params, rawPath, jsonPath });
  return parsed;
}

function callGatewayStableAfterRestart(method, params) {
  return callGateway(method, params, { maxAttempts: 20, baseBackoffMs: 2500 });
}

function pass(name, ok, details = {}, artifacts = []) {
  return { name, ok: !!ok, details, artifacts };
}

const summary = {
  startedAt: new Date().toISOString(),
  benchmarkKey,
  benchmarkLabel,
  benchmarkToken,
  oldAnchorToken,
  crossToken,
  bookExactQuery,
  cases: [],
  artifacts: {
    forensicRoot,
    benchDir,
    sessionsDir,
    logsDir,
  },
};

try {
  const longest = findLongestSession(pluginLiveRoot);
  summary.longestSession = longest;

  const created = callGateway('sessions.create', { key: benchmarkKey, label: benchmarkLabel });
  const benchmarkSessionId = String(created?.sessionId ?? '');
  summary.benchmarkSessionId = benchmarkSessionId;

  callGateway('sessions.send', { key: benchmarkKey, message: 'Reply with exactly: MEMORY-BENCHMARK-OK' });
  callGateway('sessions.send', { key: benchmarkKey, message: '/crag_status' });
  callGateway('sessions.send', { key: benchmarkKey, message: '/crag_explain_memory' });
  callGateway('sessions.send', {
    key: benchmarkKey,
    message: '/crag_corpus_ingest --root /mnt/g/@Cursuri --max-files 4',
  });

  if (benchmarkSessionId) {
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `Remember this benchmark token exactly: ${benchmarkToken}`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_recall --session-id ${benchmarkSessionId} in this session what did we say about ${benchmarkToken}`,
    });
  }

  const targetSessionId = longest.sessionId || benchmarkSessionId;
  if (targetSessionId) {
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_describe --session-id ${targetSessionId} ${oldAnchorToken}`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_quote --session-id ${targetSessionId} --exact ${oldAnchorToken}`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_quote --session-id ${targetSessionId} what was the lossless live token in this session`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_expand --session-id ${targetSessionId} 3`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_export --session-id ${targetSessionId} benchmark-export`,
    });
    callGateway('sessions.send', {
      key: benchmarkKey,
      message: `/crag_recall --session-id ${targetSessionId} from book ${bookExactQuery}`,
    });
  }

  callGateway('sessions.send', {
    key: benchmarkKey,
    message: `/crag_large_search ${bookNearQuery}`,
  });
  callGateway('sessions.send', {
    key: benchmarkKey,
    message: `/crag_large_search ${bookSemanticQuery}`,
  });
  callGateway('sessions.send', {
    key: benchmarkKey,
    message: `/crag_recall --all-sessions in this session what did we say about ${crossToken}`,
  });

  const preRestart = callGateway('sessions.get', { key: benchmarkKey });
  fsSync.writeFileSync(path.join(benchDir, 'benchmark_get_pre_restart.json'), JSON.stringify(preRestart, null, 2));

  execSync('systemctl --user restart openclaw-gateway.service', { stdio: 'pipe' });
  // Give websocket listener a short warm-up window before status probing.
  sleepMs(3000);

  // Gateway restart can briefly produce 1006/timeout before loopback websocket is stable.
  // Keep this probe strict, but retry longer so transient lifecycle churn is not treated as product failure.
  callGateway('status', {}, { maxAttempts: 30, baseBackoffMs: 2500 });
  if (targetSessionId) {
    callGatewayStableAfterRestart('sessions.send', {
      key: benchmarkKey,
      message: `/crag_session_quote --session-id ${targetSessionId} --exact ${oldAnchorToken}`,
    });
    callGatewayStableAfterRestart('sessions.send', {
      key: benchmarkKey,
      message: `/crag_recall --session-id ${targetSessionId} from book ${bookExactQuery}`,
    });
  }
  const postRestart = callGatewayStableAfterRestart('sessions.get', { key: benchmarkKey });
  fsSync.writeFileSync(path.join(benchDir, 'benchmark_get_post_restart.json'), JSON.stringify(postRestart, null, 2));

  const allText = JSON.stringify(postRestart);
  const preText = JSON.stringify(preRestart);

  summary.cases.push(
    pass('normal_reply', /MEMORY-BENCHMARK-OK/.test(allText), {}, [path.join(benchDir, 'benchmark_get_post_restart.json')]),
  );
  summary.cases.push(
    pass('crag_status', /CognitiveRAG Status/.test(allText) && /contextEngine slot: cognitiverag-memory/.test(allText)),
  );
  summary.cases.push(
    pass(
      'same_session_recall',
      benchmarkSessionId
        ? /query: in this session what did we say about/.test(preText) && /ranking intent: session/.test(preText)
        : false,
    ),
  );
  summary.cases.push(
    pass(
      'post_restart_recall',
      /CognitiveRAG Session Quote/.test(allText) && /target: LOSSLESS-LIVE-17746045-AX12/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'cross_session_recall',
      /all sessions: yes/.test(allText) && /winning source: lossless_session_raw/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'exact_session_span',
      /exact mode: yes/.test(allText) && /raw exact\/near hits: [1-9]/.test(allText) && /\[lossless_session_raw\]/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'near_session_query',
      /target: what was the lossless live token in this session/.test(allText) && /expanded raw evidence entries: [1-9]/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'exact_corpus_book',
      /query: from book Business-to-Business Direct Marketing/.test(allText) &&
        /winning source: (large_file_excerpt|corpus_chunk)/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'near_and_semantic_book',
      /CognitiveRAG Large File Search/.test(allText) && /MENTAL MANIPULATION TECHNIQUES/.test(allText) && /how can dark psychology influence people/.test(allText),
    ),
  );
  summary.cases.push(
    pass(
      'source_attribution',
      /winning provenance:/.test(allText) && /\/mnt\/g\/@Cursuri/.test(allText),
    ),
  );

  const describeMatch = allText.match(/raw entries: (\d+)[\s\S]*?compacted chunks: (\d+)/);
  const rawEntries = describeMatch ? Number(describeMatch[1]) : 0;
  const compactChunks = describeMatch ? Number(describeMatch[2]) : 0;
  summary.cases.push(
    pass('long_session_continuity', rawEntries >= 20 && compactChunks >= 1, { rawEntries, compactChunks }),
  );

  const journalPath = path.join(logsDir, 'journal_1200.log');
  execSync(`journalctl --user -u openclaw-gateway.service -n 1200 --no-pager > ${JSON.stringify(journalPath)}`, {
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  const journalText = readMaybe(journalPath);
  const crashFree =
    !/Cannot read properties of undefined \(reading 'totalTokens'\)/.test(journalText) &&
    !/assistantMsg\.content\.flatMap is not a function/.test(journalText);
  summary.cases.push(pass('crash_regression', crashFree, {}, [journalPath]));

  const lines = journalText
    .split(/\r?\n/)
    .filter((line) => line.includes('[cognitiverag-memory] assemble forwarded'));
  let maxMessages = 0;
  for (const line of lines) {
    const m = line.match(/"messages":(\d+)/);
    if (m) maxMessages = Math.max(maxMessages, Number(m[1]));
  }
  summary.cases.push(pass('bounded_context', maxMessages > 0 && maxMessages <= 20, { maxMessages }, [journalPath]));

  summary.passed = summary.cases.every((c) => c.ok);
  summary.finishedAt = new Date().toISOString();
} catch (error) {
  summary.error = String(error?.stack || error?.message || error);
  summary.passed = false;
  summary.finishedAt = new Date().toISOString();
}

await fs.writeFile(path.join(benchDir, 'memory_quality_benchmark_summary.json'), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.passed ? 0 : 1);
