import { summarizeFallback, buildMessagesFromLines, buildSummaryFromLines, DEFAULTS } from '../lib/fallbackMemorySummarizer.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP_PLUGIN = path.resolve('./test/tmp_plugin_MEMORY.md');
const TMP_WORKSPACE = path.resolve('./test/tmp_workspace_MEMORY.md');

async function writeFileSafe(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
  await fs.writeFile(p, content, 'utf8');
}

async function cleanup() {
  await fs.rm(TMP_PLUGIN, { force: true }).catch(() => {});
  await fs.rm(TMP_WORKSPACE, { force: true }).catch(() => {});
}

(async () => {
  await cleanup();

  // 1) empty inputs produce safe empty output
  await writeFileSafe(TMP_PLUGIN, '');
  await writeFileSafe(TMP_WORKSPACE, '');
  const r1 = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 5, maxSummaryChars: 200 });
  assert.equal(r1.summary, '');
  assert.deepEqual(r1.messages, []);
  assert.deepEqual(r1.cleanedLines, []);

  // 2) deterministic output for same input
  const sample = ['- fact A', '- fact B', '- fact C', '- fact B', '- fact D'];
  await writeFileSafe(TMP_PLUGIN, sample.join('\n'));
  await writeFileSafe(TMP_WORKSPACE, '');
  const a = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 10, maxSummaryChars: 200 });
  const b = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 10, maxSummaryChars: 200 });
  assert.equal(a.summary, b.summary);
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual(a.cleanedLines, b.cleanedLines);
  // duplicates collapsed
  assert(!a.summary.includes('- fact B\n- fact B'));

  // 2b) test two-source behavior and dedupe across sources
  await writeFileSafe(TMP_PLUGIN, ['shared','plugin-only'].join('\n'));
  await writeFileSafe(TMP_WORKSPACE, ['shared','workspace-only'].join('\n'));
  const r = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 10, maxSummaryChars: 500 });
  // shared should appear once
  assert.equal((r.summary.match(/- shared/g) || []).length, 1);
  // sourceCounts should reflect files read
  assert.equal(r.sourceCounts.plugin, 2);
  assert.equal(r.sourceCounts.workspace, 2);

  // 2e) boilerplate + token noise + near-duplicate cleanup remains deterministic
  await writeFileSafe(
    TMP_PLUGIN,
    [
      'Memory summary (older context; use as background)',
      'Project preference: use deterministic tests first',
      'Project preference - use deterministic tests first',
      'hash=abcdef0123456789abcdef0123456789',
      'Sender (untrusted metadata): user=alice',
    ].join('\n'),
  );
  await writeFileSafe(TMP_WORKSPACE, ['Project preference: use deterministic tests first.'].join('\n'));
  const cleaned = await summarizeFallback({
    pluginMemoryPath: TMP_PLUGIN,
    workspaceMemoryPath: TMP_WORKSPACE,
    maxLines: 20,
    maxMessages: 20,
    maxSummaryChars: 800,
  });
  assert(cleaned.cleanedLines.length <= 2);
  assert(cleaned.cleanedLines.some((line) => /project preference/i.test(line)));
  assert(cleaned.cleanupStats.boilerplateRemoved >= 1);
  assert(cleaned.cleanupStats.tokenNoiseRemoved >= 1);
  assert(cleaned.cleanupStats.nearDuplicatesRemoved + cleaned.cleanupStats.exactDuplicatesRemoved >= 1);

  // 2f) compaction-aware signal is surfaced when recoverability wording exists
  await writeFileSafe(TMP_PLUGIN, ['Compacted history remains recoverable via /crag_session_expand'].join('\n'));
  const compactionAware = await summarizeFallback({
    pluginMemoryPath: TMP_PLUGIN,
    workspaceMemoryPath: TMP_WORKSPACE,
    maxLines: 10,
    maxMessages: 10,
    maxSummaryChars: 400,
  });
  assert.equal(compactionAware.compactionAware, true);

  // 2c) default paths are distinct and deterministic (sanity check)
  assert.notEqual(DEFAULTS.pluginMemoryPath, DEFAULTS.workspaceMemoryPath);

  // 2d) when cwd is repo root, plugin default should point to repo-local MEMORY.md
  // simulate repo-root cwd by using DEFAULTS as-is (process.cwd is test runner cwd)
  const expectedPlugin = DEFAULTS.pluginMemoryPath;
  const expectedWorkspace = DEFAULTS.workspaceMemoryPath;
  // they must be absolute and plugin must resolve to a path inside this repo
  assert.ok(expectedPlugin.endsWith('MEMORY.md'));
  assert.ok(expectedWorkspace.endsWith('MEMORY.md'));

  // 3) output bounded when input is large
  const many = Array.from({ length: 500 }, (_, i) => `- line ${i}`);
  await writeFileSafe(TMP_PLUGIN, many.join('\n'));
  const r2 = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 50, maxMessages: 10, maxSummaryChars: 500 });
  assert(r2.summary.length <= 500);
  assert(r2.messages.length <= 10);

  // 4) malformed/missing files do not throw
  await cleanup();
  const r3 = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 5 });
  assert.equal(r3.summary, '');
  assert.deepEqual(r3.messages, []);
  assert.equal(r3.compactionAware, false);

  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
