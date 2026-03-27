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
const corpusIngestCmd = regs.commands.find((c) => c?.name === 'crag_corpus_ingest');
const corpusSearchCmd = regs.commands.find((c) => c?.name === 'crag_corpus_search');
const corpusDescribeCmd = regs.commands.find((c) => c?.name === 'crag_corpus_describe');
assert.ok(recallCmd && typeof recallCmd.handler === 'function', 'crag_recall command must register');
assert.ok(corpusIngestCmd && typeof corpusIngestCmd.handler === 'function', 'crag_corpus_ingest command must register');
assert.ok(corpusSearchCmd && typeof corpusSearchCmd.handler === 'function', 'crag_corpus_search command must register');
assert.ok(corpusDescribeCmd && typeof corpusDescribeCmd.handler === 'function', 'crag_corpus_describe command must register');

const restoreFetch = installBackendMock();

const corpusRoot = path.join(tmpDir, 'corpus-fixtures');
await fs.mkdir(corpusRoot, { recursive: true });
const sourcePathA = path.join(corpusRoot, 'a_foundation.txt');
const sourcePathB = path.join(corpusRoot, 'b_exact-token.txt');
const sourcePathC = path.join(corpusRoot, 'c_semantic.txt');
const corpusToken = `CORPUS-SLICE-${Date.now()}`;
await fs.writeFile(
  sourcePathA,
  [
    'AI Systems Field Notes',
    'This file discusses retrieval quality, chunk provenance, and exact recall for production assistants.',
    'The chapter compares naive memory mirrors with chunk-attributed retrieval.',
  ].join('\n'),
);
await fs.writeFile(
  sourcePathB,
  [
    'Precision Token Guide',
    `Validation token for exact retrieval is ${corpusToken}.`,
    'Use this token to verify exact corpus lookup under restart conditions.',
  ].join('\n'),
);
await fs.writeFile(
  sourcePathC,
  [
    'Semantic Recall Primer',
    'Teams using compacted history still need expandable chunk evidence for older turns.',
    'A stable context layer should preserve source path and chunk identity.',
  ].join('\n'),
);

const ingest = await corpusIngestCmd.handler({
  args: [`--root ${corpusRoot} --max-files 3`],
});
assert.equal(typeof ingest?.text, 'string', 'corpus ingest must return text');
assert.match(ingest.text, /ingested files:\s*3/i, 'corpus ingest should process three files');
assert.match(ingest.text, /total corpus docs:\s*3/i, 'corpus store should include three docs');
assert.match(ingest.text, /total corpus chunks:\s*[1-9]/i, 'corpus store should include chunks');

const searchExact = await corpusSearchCmd.handler({
  args: [corpusToken],
});
assert.equal(typeof searchExact?.text, 'string', 'corpus search exact must return text');
assert.match(searchExact.text, /hits:\s*[1-9]/i, 'corpus search should find exact token');
assert.match(searchExact.text, /\[corpus_chunk\]/i, 'corpus search should expose corpus provenance');
assert.match(searchExact.text, new RegExp(corpusToken), 'exact token should be returned');
assert.match(searchExact.text, new RegExp(sourcePathB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'source path must be present');

const searchSemantic = await corpusSearchCmd.handler({
  args: ['expandable chunk evidence'],
});
assert.equal(typeof searchSemantic?.text, 'string', 'corpus search semantic must return text');
assert.match(searchSemantic.text, /hits:\s*[1-9]/i, 'token-overlap semantic query should return hits');
assert.match(
  searchSemantic.text,
  new RegExp(sourcePathC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'semantic result should include expected source path',
);

const sessionId = 'sess-crag-corpus-slice';
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:corpus-slice',
  message: { role: 'user', content: 'corpus recall bridge turn' },
});
const recall = await recallCmd.handler({ args: [`--session-id ${sessionId} ${corpusToken}`] });
assert.equal(typeof recall?.text, 'string', 'recall must return text');
assert.match(recall.text, /corpus hits:\s*[1-9]/i, 'crag_recall should include corpus hit count');
assert.match(recall.text, /\[corpus_chunk\]/i, 'crag_recall should expose corpus provenance marker');
assert.match(recall.text, new RegExp(sourcePathB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'crag_recall should show source path provenance');

const describe = await corpusDescribeCmd.handler({});
assert.equal(typeof describe?.text, 'string', 'corpus describe must return text');
assert.match(describe.text, /docs:\s*3/i, 'describe should show corpus docs count');
assert.match(describe.text, /chunks:\s*[1-9]/i, 'describe should show corpus chunk count');

// Restart plugin instance and ensure corpus retrieval remains durable.
const regsAfterRestart = { commands: [], engines: {} };
const apiAfterRestart = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (cmd) => regsAfterRestart.commands.push(cmd),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regsAfterRestart.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
};
register(apiAfterRestart);
const corpusSearchAfterRestart = regsAfterRestart.commands.find((c) => c?.name === 'crag_corpus_search');
assert.ok(corpusSearchAfterRestart && typeof corpusSearchAfterRestart.handler === 'function', 'corpus search command must register after restart');
const searchAfterRestart = await corpusSearchAfterRestart.handler({ args: [corpusToken] });
assert.equal(typeof searchAfterRestart?.text, 'string', 'post-restart corpus search must return text');
assert.match(searchAfterRestart.text, /hits:\s*[1-9]/i, 'post-restart corpus search should still return hits');
assert.match(searchAfterRestart.text, new RegExp(sourcePathB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'post-restart result should preserve provenance');

restoreFetch();
console.log('corpus ingestion slice test passed');
