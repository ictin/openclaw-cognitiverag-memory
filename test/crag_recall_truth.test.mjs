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

function installBackendMock() {
  const realFetch = global.fetch;
  const sessions = new Map();
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/session_append_message')) {
      const sessionId = String(body?.session_id ?? '');
      const arr = sessions.get(sessionId) ?? [];
      arr.push({ sender: body?.sender ?? 'user', text: String(body?.text ?? '') });
      sessions.set(sessionId, arr);
      return makeFetchResponse(200, { status: 'inserted' });
    }
    if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_assemble_context')) {
      const sessionId = String(body?.session_id ?? '');
      const freshTail = sessionId === '__crag_probe__' ? [] : sessions.get(sessionId) ?? [];
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-recall-truth-'));
const regs = { commands: [], engines: {} };
const api = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (cmd) => regs.commands.push(cmd),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regs.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
};

register(api);
const engine = regs.engines['cognitiverag-memory'];
assert.ok(engine, 'context engine must register');

const recallCmd = regs.commands.find((c) => c?.name === 'crag_recall');
const explainCmd = regs.commands.find((c) => c?.name === 'crag_explain_memory');
assert.ok(recallCmd && typeof recallCmd.handler === 'function', 'crag_recall command must register');
assert.ok(explainCmd && typeof explainCmd.handler === 'function', 'crag_explain_memory command must register');

const restoreFetch = installBackendMock();

const sessionId = 'sess-crag-recall-truth';
const token = `TOKEN-${Date.now()}`;

const ingested = await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:recall-truth',
  message: {
    role: 'user',
    content: `Remember this durable fact: ${token}`,
  },
});
assert.equal(ingested.ingested, true, 'ingest must succeed');

// Hide both mirrors to prove backend-native lookup works.
await fs.rm(path.join(tmpDir, 'MEMORY.md'), { force: true });
await fs.rm(path.join(process.cwd(), 'MEMORY.md'), { force: true });

const recall = await recallCmd.handler({
  args: [token],
  sessionId,
});
assert.equal(typeof recall?.text, 'string', 'crag_recall must return text');
assert.match(recall.text, /backend hits:\s*[1-9]/i, 'backend hits must be reported');
assert.match(recall.text, /\[backend_session_memory\]/i, 'backend provenance marker must be present');
assert.match(recall.text, new RegExp(token), 'recalled token must be present');

// Host slash-command paths may provide sessionKey without sessionId.
const recallViaSessionKeyOnly = await recallCmd.handler({
  args: [token],
  sessionKey: 'agent:main:recall-truth',
});
assert.equal(typeof recallViaSessionKeyOnly?.text, 'string', 'sessionKey-only recall must return text');
assert.match(recallViaSessionKeyOnly.text, /backend hits:\s*[1-9]/i, 'sessionKey-only recall must resolve backend hits');
assert.match(recallViaSessionKeyOnly.text, /\[backend_session_memory\]/i, 'sessionKey-only recall must preserve provenance');

const recallViaExplicitSessionId = await recallCmd.handler({
  args: [`--session-id ${sessionId} ${token}`],
});
assert.equal(typeof recallViaExplicitSessionId?.text, 'string', 'explicit-session-id recall must return text');
assert.match(recallViaExplicitSessionId.text, /sessionId source:\s*explicit/i, 'explicit-session-id source must be surfaced');
assert.match(recallViaExplicitSessionId.text, /backend hits:\s*[1-9]/i, 'explicit-session-id recall must resolve backend hits');

const explain = await explainCmd.handler({});
assert.equal(typeof explain?.text, 'string', 'crag_explain_memory must return text');
assert.match(explain.text, /cognitiverag-memory plugin loaded:\s*yes/i, 'truth text must confirm active plugin');
assert.match(explain.text, /backend\/session memory/i, 'truth text must mention backend/session memory');
assert.doesNotMatch(explain.text, /no cognitiverag plugin/i, 'truth text must not deny plugin presence');

restoreFetch();
console.log('crag recall truth test passed');
