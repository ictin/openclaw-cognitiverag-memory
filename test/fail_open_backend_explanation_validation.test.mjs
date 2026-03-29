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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-fail-open-backend-explanation-'));
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
assert.ok(engine && typeof engine.assemble === 'function');

const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (u.endsWith('/session_assemble_context')) {
    assert.equal(body.intent_family, 'exact_recall');
    return makeFetchResponse(200, {
      fresh_tail: [{ sender: 'user', text: 'detailA was mentioned earlier' }],
      summaries: [{ summary: 'old summary' }],
      explanation: 'invalid-shape',
    });
  }
  if (u.endsWith('/session_append_message')) return makeFetchResponse(200, { status: 'inserted' });
  if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
  if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
  throw new Error(`unexpected fetch URL: ${u}`);
};

try {
  const out = await engine.assemble({
    sessionId: 'sess-fail-open',
    sessionKey: 'agent:main:fail-open',
    prompt: 'What did we say earlier about detailA?',
    messages: [{ role: 'user', content: 'What did we say earlier about detailA?' }],
    tokenBudget: 2048,
  });
  assert.ok(Array.isArray(out?.messages), 'assemble should still return messages in fail-open path');
  assert.ok(Number.isFinite(out?.totalTokens), 'assemble totalTokens should remain finite');
  const prompt = String(out?.systemPromptAddition ?? '');
  assert.match(prompt, /Backend selector explanation unavailable \(fail-open\):/i);
} finally {
  global.fetch = realFetch;
}

console.log('fail-open backend explanation validation test passed');

