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
      const freshTail = sessionId === '__crag_probe__' ? [] : (sessions.get(sessionId) ?? []).slice(-200);
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-hybrid-ranking-'));
const corpusRoot = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusRoot, { recursive: true });

const sessionToken = `SESSION-RANK-${Date.now()}`;
const bookPhrase = 'Business-to-Business Direct Marketing';
const mirrorNoise = `Mirror line ${bookPhrase} ${Date.now()}`;

const smallPath = path.join(corpusRoot, 'small.md');
await fs.writeFile(
  smallPath,
  [
    '# Small Corpus',
    `This document repeats ${bookPhrase} and ${sessionToken}.`,
    'This should exist as a normal corpus chunk.',
  ].join('\n'),
);

const largePath = path.join(corpusRoot, 'large.txt');
const largePayload = (`${bookPhrase} appears here with source-level provenance.\n` + 'filler '.repeat(200)).repeat(500);
await fs.writeFile(largePath, largePayload);

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
const cmd = Object.fromEntries(regs.commands.map((c) => [c.name, c]));

for (const name of ['crag_recall', 'crag_corpus_ingest']) {
  assert.ok(cmd[name] && typeof cmd[name].handler === 'function', `${name} command should register`);
}

const sessionId = 'hybrid-rank-session';
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:hybrid-rank',
  message: {
    role: 'user',
    content: `In this session remember token ${sessionToken}.`,
  },
});
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:hybrid-rank',
  message: {
    role: 'assistant',
    content: `Acknowledged token ${sessionToken}.`,
  },
});

await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), `# Fallback\n- ${mirrorNoise}\n- ${sessionToken}\n`);

const ingestRes = await cmd.crag_corpus_ingest.handler({ args: [`--root ${corpusRoot} --max-files 4`] });
assert.match(String(ingestRes?.text ?? ''), /intercepted large files:\s*[1-9]/i, 'large file should be intercepted');
assert.match(String(ingestRes?.text ?? ''), /ingested files:\s*[1-9]/i, 'small file should be ingested');

const bookRecall = await cmd.crag_recall.handler({
  args: [`--session-id ${sessionId} from book ${bookPhrase}`],
  sessionId,
  sessionKey: 'agent:main:hybrid-rank',
});
const bookText = String(bookRecall?.text ?? '');
assert.match(bookText, /ranking intent:\s*corpus/i, 'book query should be treated as corpus intent');
assert.match(bookText, /winning source:\s*(large_file_excerpt|corpus_chunk)/i, 'book query should prioritize corpus/large-file sources');
assert.doesNotMatch(bookText, /winning source:\s*fallback_mirror_/i, 'mirror should not win when corpus/large-file sources exist');
assert.match(bookText, /winning reason:/i, 'winning reason should be surfaced');
assert.match(bookText, /winning provenance:/i, 'winning provenance should be surfaced');

const sessionRecall = await cmd.crag_recall.handler({
  args: [`--session-id ${sessionId} in this session what did we say about ${sessionToken}`],
  sessionId,
  sessionKey: 'agent:main:hybrid-rank',
});
const sessionText = String(sessionRecall?.text ?? '');
assert.match(sessionText, /ranking intent:\s*session/i, 'session query should be treated as session intent');
assert.match(
  sessionText,
  /winning source:\s*(lossless_session_raw|lossless_session_compact|backend_session_memory)/i,
  'session query should prioritize session-oriented sources',
);
assert.match(sessionText, /local lossless hits:\s*[1-9]/i, 'session query should surface local lossless hits');
assert.match(sessionText, /fallback sources:/i, 'fallback source list should be present');

restoreFetch();
console.log('hybrid retrieval ranking test passed');
