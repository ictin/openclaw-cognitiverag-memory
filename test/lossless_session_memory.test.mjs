import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import register from '../index.js';

function makeFetchResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function installFetchMock() {
  const sessions = new Map();
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/session_append_message')) {
      const sessionId = String(body?.session_id ?? '');
      const arr = sessions.get(sessionId) ?? [];
      arr.push({ sender: String(body?.sender ?? 'user'), text: String(body?.text ?? '') });
      sessions.set(sessionId, arr);
      return makeFetchResponse(200, { status: 'inserted' });
    }
    if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_assemble_context')) {
      const sessionId = String(body?.session_id ?? '');
      const tail = sessions.get(sessionId) ?? [];
      const freshTail = tail.slice(-20);
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-lossless-session-'));
const regs = { commands: [], engines: {} };
const api = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (cmd) => regs.commands.push(cmd),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regs.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
  logger: { info: () => {}, warn: () => {} },
};

register(api);
const engine = regs.engines['cognitiverag-memory'];
assert.ok(engine, 'context engine should register');

const restoreFetch = installFetchMock();

const sessionId = 'lossless-session-a';
const oldToken = `LOSSLESS-OLD-${Date.now()}`;
const recentToken = `LOSSLESS-RECENT-${Date.now()}`;

for (let i = 0; i < 30; i += 1) {
  const token = i === 2 ? oldToken : i === 28 ? recentToken : `noise-${i}`;
  const content =
    i === 2
      ? [{ type: 'text', text: `Older durable turn ${token}` }, { type: 'text', text: 'part-2' }]
      : `Turn ${i} ${token}`;
  const ing = await engine.ingest({
    sessionId,
    sessionKey: 'agent:main:lossless-a',
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content,
    },
  });
  assert.equal(ing?.ingested, true, `ingest ${i} should succeed`);
}

const safeId = 'lossless-session-a';
const rawPath = path.join(tmpDir, 'session_memory', `raw_${safeId}.jsonl`);
const compactPath = path.join(tmpDir, 'session_memory', `compact_${safeId}.json`);
const rawText = await fs.readFile(rawPath, 'utf8');
const rawLines = rawText.trim().split(/\r?\n/).filter(Boolean);
assert.equal(rawLines.length, 30, 'raw store should preserve every ingested message');
const parsedRaw = rawLines.map((line) => JSON.parse(line));
assert.ok(parsedRaw.some((entry) => Array.isArray(entry.parts) && entry.parts.length >= 2), 'message parts should be preserved');

const compactStore = JSON.parse(await fs.readFile(compactPath, 'utf8'));
assert.ok(Array.isArray(compactStore?.items), 'compact store items should exist');
assert.ok(compactStore.items.length >= 1, 'older history should be compacted into chunks');

const assembled = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:lossless-a',
  messages: [],
  tokenBudget: 2048,
});
assert.ok(Array.isArray(assembled?.messages), 'assemble messages should be array');
assert.ok(assembled.messages.length <= 20, 'active context should stay bounded');
assert.ok(typeof assembled?.systemPromptAddition === 'string', 'assemble should include systemPromptAddition');
assert.match(assembled.systemPromptAddition, /Compacted session history/i, 'assemble should include compacted session block');
assert.ok(Number.isFinite(assembled?.totalTokens), 'assemble totalTokens should be finite');

const cmd = Object.fromEntries(regs.commands.map((c) => [c.name, c]));
for (const required of ['crag_session_search', 'crag_session_describe', 'crag_session_expand', 'crag_session_export', 'crag_recall', 'crag_explain_memory']) {
  assert.ok(cmd[required] && typeof cmd[required].handler === 'function', `${required} command should register`);
}

const searchRes = await cmd.crag_session_search.handler({ args: [`--session-id ${sessionId} ${oldToken}`] });
assert.match(String(searchRes?.text ?? ''), /hits:\s*[1-9]/i, 'session search should find older token');
assert.match(String(searchRes?.text ?? ''), /lossless_session_raw|lossless_session_compact/i, 'session search should surface local lossless source');

const describeRes = await cmd.crag_session_describe.handler({ args: [`--session-id ${sessionId}`] });
assert.match(String(describeRes?.text ?? ''), /raw entries:\s*30/i, 'describe should report raw count');
assert.match(String(describeRes?.text ?? ''), /compacted chunks:\s*[1-9]/i, 'describe should report compacted chunks');

const chunkId = String(compactStore.items[0]?.chunkId ?? '');
assert.ok(chunkId, 'compact chunk id should exist');
const expandRes = await cmd.crag_session_expand.handler({ args: [`--session-id ${sessionId} ${chunkId}`] });
assert.match(String(expandRes?.text ?? ''), /expanded entries:\s*[1-9]/i, 'expand should expose raw entries for chunk');
assert.match(String(expandRes?.text ?? ''), /seq\s+/i, 'expand should include seq references');

const exportRes = await cmd.crag_session_export.handler({ args: [`--session-id ${sessionId} unit-test`] });
const exportPathMatch = String(exportRes?.text ?? '').match(/export path:\s*(.+)$/m);
assert.ok(exportPathMatch?.[1], 'export should return an export path');
const exportPath = exportPathMatch[1].trim();
const exportPayload = JSON.parse(await fs.readFile(exportPath, 'utf8'));
assert.equal(exportPayload?.sessionId, sessionId, 'export payload should keep session id');
assert.equal(exportPayload?.rawEntryCount, 30, 'export should include raw entry count');

const recallRes = await cmd.crag_recall.handler({ args: [`--session-id ${sessionId} ${oldToken}`] });
assert.match(String(recallRes?.text ?? ''), /local lossless hits:\s*[1-9]/i, 'crag_recall should include local lossless hits');
assert.match(String(recallRes?.text ?? ''), /\[lossless_session_raw\]|\[lossless_session_compact\]/i, 'crag_recall should surface local lossless provenance');

const sessionIdB = 'lossless-session-b';
const crossToken = `LOSSLESS-CROSS-${Date.now()}`;
await engine.ingest({
  sessionId: sessionIdB,
  sessionKey: 'agent:main:lossless-b',
  message: {
    role: 'user',
    content: `Cross session token ${crossToken}`,
  },
});
const recallAllRes = await cmd.crag_recall.handler({ args: [`--all-sessions ${crossToken}`] });
assert.match(String(recallAllRes?.text ?? ''), /all sessions:\s*yes/i, 'crag_recall should acknowledge all-sessions mode');
assert.match(String(recallAllRes?.text ?? ''), /local lossless hits:\s*[1-9]/i, 'all-sessions recall should find cross-session token');

const explainRes = await cmd.crag_explain_memory.handler({});
assert.match(String(explainRes?.text ?? ''), /local lossless session layer/i, 'architecture truth should mention local lossless layer');

// Simulate plugin restart and ensure sessionKey -> sessionId mapping survives.
const regsAfterRestart = { commands: [], engines: {} };
const apiAfterRestart = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (c) => regsAfterRestart.commands.push(c),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regsAfterRestart.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
  logger: { info: () => {}, warn: () => {} },
};
register(apiAfterRestart);
const cmdAfterRestart = Object.fromEntries(regsAfterRestart.commands.map((c) => [c.name, c]));
const searchAfterRestart = await cmdAfterRestart.crag_session_search.handler({
  args: [oldToken],
  sessionKey: 'agent:main:lossless-a',
});
assert.match(
  String(searchAfterRestart?.text ?? ''),
  /sessionId:\s*lossless-session-a/i,
  'search should resolve session id from persisted key map after restart',
);
assert.match(
  String(searchAfterRestart?.text ?? ''),
  /hits:\s*[1-9]/i,
  'search should still return hits after restart without explicit session id',
);

restoreFetch();
console.log('lossless session memory test passed');
