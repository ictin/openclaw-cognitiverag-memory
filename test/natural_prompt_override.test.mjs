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
      const freshTail = sessionId === '__crag_probe__' ? [] : (sessions.get(sessionId) ?? []).slice(-50);
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-natural-prompt-override-'));
const corpusRoot = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusRoot, { recursive: true });
await fs.writeFile(
  path.join(corpusRoot, 'YouTube Secrets by Nick Walsh - Synopsis.txt'),
  '# YouTube Secrets by Nick Walsh\nSynopsis text with practical channel setup guidance.',
);

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
assert.ok(cmd.crag_corpus_ingest && typeof cmd.crag_corpus_ingest.handler === 'function');

const restoreFetch = installFetchMock();
await cmd.crag_corpus_ingest.handler({ args: [`--root ${corpusRoot} --max-files 3`] });

const assembled = await engine.assemble({
  sessionId: 'prompt-override-session',
  sessionKey: 'agent:main:prompt-override',
  prompt: 'What can you tell me about youtube secrets?',
  messages: [
    { role: 'user', content: 'What do you remember?' },
    { role: 'assistant', content: 'old memory summary answer' },
  ],
  tokenBudget: 4096,
});

const out = JSON.stringify(assembled?.messages ?? []);
assert.match(out, /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i, 'prompt field should drive current intent over stale user history');
restoreFetch();
console.log('natural prompt override test passed');
