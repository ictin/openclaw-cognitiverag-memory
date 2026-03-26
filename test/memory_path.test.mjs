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
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/session_append_message')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_assemble_context')) return makeFetchResponse(200, { fresh_tail: [], summaries: [] });
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-memory-path-'));
const api = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: () => {},
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    api._engines[id] = factory();
  },
  _engines: {},
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
};
register(api);
const engine = api._engines['cognitiverag-memory'];
assert.ok(engine && typeof engine.ingest === 'function' && typeof engine.assemble === 'function');

const restoreFetch = installFetchMock();

const token = `TOKEN-${Date.now()}`;
const first = await engine.ingest({
  sessionId: 'mem-path-1',
  sessionKey: 'agent:main:memory-path-1',
  message: {
    role: 'user',
    content: `Sender (untrusted metadata):\n\`\`\`json\n{\"label\":\"cli\",\"id\":\"cli\"}\n\`\`\`\n\nRemember this exact durable fact for later: ${token}`,
  },
});
assert.equal(first.ingested, true, 'ingest should succeed');

const second = await engine.ingest({
  sessionId: 'mem-path-1',
  sessionKey: 'agent:main:memory-path-1',
  message: { role: 'user', content: `Remember this exact durable fact for later: ${token}` },
});
assert.equal(second.ingested, true, 'repeat ingest should still succeed');

const memoryPath = path.join(tmpDir, 'MEMORY.md');
const memoryText = await fs.readFile(memoryPath, 'utf8');
assert.ok(memoryText.includes(token), 'fallback mirror should contain promoted durable fact');
assert.equal((memoryText.match(new RegExp(token, 'g')) || []).length, 1, 'durable fact should not duplicate');

const assembled = await engine.assemble({
  sessionId: 'mem-path-2',
  sessionKey: 'agent:main:memory-path-2',
  messages: [],
  tokenBudget: 4096,
});

assert.ok(Array.isArray(assembled.messages), 'assemble should return messages array');
assert.ok(Number.isFinite(assembled.totalTokens), 'assemble totalTokens must be finite');
assert.ok(typeof assembled.systemPromptAddition === 'string', 'fallback summary should be included as systemPromptAddition');
assert.ok(assembled.systemPromptAddition.includes(token), 'fallback summary should include promoted durable fact');

restoreFetch();
console.log('memory path test passed');
