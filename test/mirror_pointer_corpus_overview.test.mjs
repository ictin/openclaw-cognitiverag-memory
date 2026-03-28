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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-mirror-pointer-'));
const corpusDir = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusDir, { recursive: true });
const synopsisPath = path.join(corpusDir, 'YouTube Secrets by Nick Walsh - Synopsis.txt');
await fs.writeFile(
  synopsisPath,
  [
    '# YouTube Secrets by Nick Walsh',
    'Synopsis: focus on niche clarity, retention loops, thumbnail testing, and consistency.',
  ].join('\n'),
);

await fs.writeFile(
  path.join(tmpDir, 'MEMORY.md'),
  [
    '# MEMORY',
    '- CORPUS_TOKEN=X ; SOURCE_PATH=' + synopsisPath + ' ; TITLE=YouTube Secrets by Nick Walsh',
  ].join('\n'),
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

const restoreFetch = installFetchMock();
const out = await engine.assemble({
  sessionId: 'mirror-pointer-corpus-session',
  sessionKey: 'agent:main:mirror-pointer-corpus-session',
  prompt: 'What can you tell me about youtube secrets?',
  messages: [{ role: 'user', content: 'What can you tell me about youtube secrets?' }],
  tokenBudget: 4096,
});
const serialized = JSON.stringify(out?.messages ?? []);
assert.match(serialized, /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i);
assert.match(serialized, /youtube secrets/i, 'deterministic corpus output should use mirror-linked source pointer content');
assert.match(serialized, /mirror-priority excerpt|source_path/i, 'output should include mirror-pointer provenance');

restoreFetch();
console.log('mirror pointer corpus overview test passed');
