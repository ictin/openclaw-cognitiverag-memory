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
  global.fetch = async (url, init = {}) => {
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
      return makeFetchResponse(200, { fresh_tail: tail.slice(-20), summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-long-session-span-'));
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
const cmd = Object.fromEntries(regs.commands.map((c) => [c.name, c]));
assert.ok(cmd.crag_session_quote && typeof cmd.crag_session_quote.handler === 'function', 'crag_session_quote must register');

const restoreFetch = installFetchMock();
const sessionId = 'long-span-session-a';
const oldExact = `OLDER-EXACT-SPAN-${Date.now()}`;
const laterExact = `LATER-EXACT-SPAN-${Date.now()}`;

for (let i = 0; i < 72; i += 1) {
  let content = `Turn ${i} topic-${i % 7}`;
  if (i === 3) content = `Early durable note: ${oldExact}.`;
  if (i === 58) content = `Later durable note: ${laterExact}.`;
  const ing = await engine.ingest({
    sessionId,
    sessionKey: 'agent:main:long-span-a',
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content,
    },
  });
  assert.equal(ing?.ingested, true, `ingest ${i} should succeed`);
}

const assembled = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:long-span-a',
  messages: [],
  tokenBudget: 2048,
});
assert.ok(Array.isArray(assembled?.messages), 'assemble messages should be array');
assert.ok(assembled.messages.length <= 20, 'long session active context should stay bounded');
assert.match(String(assembled?.systemPromptAddition ?? ''), /Compacted session history/i, 'compacted history block should be present');
assert.ok(Number.isFinite(assembled?.totalTokens), 'totalTokens should be finite');

const describe = await cmd.crag_session_describe.handler({ args: [`--session-id ${sessionId}`] });
assert.match(String(describe?.text ?? ''), /raw entries:\s*72/i, 'describe should report all raw entries');
assert.match(String(describe?.text ?? ''), /compacted chunks:\s*[1-9]/i, 'describe should report compacted chunks');

const quoteExact = await cmd.crag_session_quote.handler({ args: [`--session-id ${sessionId} --exact ${oldExact}`] });
assert.match(String(quoteExact?.text ?? ''), /exact mode:\s*yes/i, 'quote should show exact mode');
assert.match(String(quoteExact?.text ?? ''), /raw exact\/near hits:\s*[1-9]/i, 'quote should return raw exact hits');
assert.match(String(quoteExact?.text ?? ''), /lossless_session_raw/i, 'quote should include raw source type');
assert.match(String(quoteExact?.text ?? ''), /seq \d+\-\d+/i, 'quote should include seq provenance');

const quoteNear = await cmd.crag_session_quote.handler({
  args: [`--session-id ${sessionId} what was the early durable note ${oldExact} in this session`],
});
assert.match(String(quoteNear?.text ?? ''), /retrieval mode:\s*query/i, 'quote should use query mode');
assert.match(String(quoteNear?.text ?? ''), /expanded raw evidence entries:\s*[1-9]/i, 'quote should provide expanded raw evidence');

const quoteSeq = await cmd.crag_session_quote.handler({ args: [`--session-id ${sessionId} seq:1-6`] });
assert.match(String(quoteSeq?.text ?? ''), /retrieval mode:\s*seq-range/i, 'seq-range mode should be supported');
assert.match(String(quoteSeq?.text ?? ''), /source:\s*lossless_session_raw/i, 'seq-range mode should be raw');

const recallOld = await cmd.crag_recall.handler({
  args: [`--session-id ${sessionId} in this session what did we say about ${oldExact}`],
  sessionId,
  sessionKey: 'agent:main:long-span-a',
});
assert.match(String(recallOld?.text ?? ''), /ranking intent:\s*session/i, 'session intent should be detected');
assert.match(String(recallOld?.text ?? ''), /winning source:\s*(lossless_session_raw|lossless_session_compact|backend_session_memory)/i, 'session recall should prioritize session sources');

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
const quoteAfterRestart = await cmdAfterRestart.crag_session_quote.handler({
  args: [`--session-id ${sessionId} --exact ${oldExact}`],
});
assert.match(String(quoteAfterRestart?.text ?? ''), /raw exact\/near hits:\s*[1-9]/i, 'quote should remain restart-stable');

restoreFetch();
console.log('long session exact span test passed');
