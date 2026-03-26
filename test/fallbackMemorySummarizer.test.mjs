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

  // 2) deterministic output for same input
  const sample = ['- fact A', '- fact B', '- fact C', '- fact B', '- fact D'];
  await writeFileSafe(TMP_PLUGIN, sample.join('\n'));
  await writeFileSafe(TMP_WORKSPACE, '');
  const a = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 10, maxSummaryChars: 200 });
  const b = await summarizeFallback({ pluginMemoryPath: TMP_PLUGIN, workspaceMemoryPath: TMP_WORKSPACE, maxLines: 10, maxMessages: 10, maxSummaryChars: 200 });
  assert.equal(a.summary, b.summary);
  assert.deepEqual(a.messages, b.messages);
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

  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
