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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-corpus-slice-'));
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
assert.ok(recallCmd && typeof recallCmd.handler === 'function', 'crag_recall command must register');

const restoreFetch = installBackendMock();

const sessionId = 'sess-crag-corpus-slice';
const sourcePath = '/mnt/g/@Cursuri/YouTube Secrets - Nick Walsh/Synopsis.txt';
const corpusToken = `CORPUS-SLICE-${Date.now()}`;
const ingestText = `CORPUS_TOKEN=${corpusToken}; SOURCE_PATH=${sourcePath}; TITLE=YouTube Secrets by Nick Walsh`;

const ingested = await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:corpus-slice',
  message: {
    role: 'user',
    content: ingestText,
  },
});
assert.equal(ingested.ingested, true, 'ingest must succeed');

await fs.rm(path.join(tmpDir, 'MEMORY.md'), { force: true });
await fs.rm(path.join(process.cwd(), 'MEMORY.md'), { force: true });

const recall = await recallCmd.handler({
  args: [`--session-id ${sessionId} ${corpusToken}`],
});
assert.equal(typeof recall?.text, 'string', 'recall must return text');
assert.match(recall.text, /sessionId source:\s*explicit/i, 'recall must report explicit session id source');
assert.match(recall.text, /backend hits:\s*[1-9]/i, 'backend hits must be present');
assert.match(recall.text, /fallback mirror hits:\s*0/i, 'mirror hits must remain zero with mirrors hidden');
assert.match(recall.text, /\[backend_session_memory\]/i, 'backend provenance marker must be present');
assert.match(recall.text, new RegExp(corpusToken), 'corpus token must be recallable');
assert.match(recall.text, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'source path provenance must be surfaced');

restoreFetch();
console.log('corpus ingestion slice test passed');
