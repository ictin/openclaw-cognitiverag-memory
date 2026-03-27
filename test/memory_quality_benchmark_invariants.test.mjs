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
      arr.push({
        sender: String(body?.sender ?? 'user'),
        text: String(body?.text ?? ''),
      });
      sessions.set(sessionId, arr);
      return makeFetchResponse(200, { status: 'inserted' });
    }
    if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_assemble_context')) {
      const sessionId = String(body?.session_id ?? '');
      const freshTail = (sessions.get(sessionId) ?? []).slice(-20);
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return () => {
    global.fetch = realFetch;
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-memory-benchmark-invariants-'));
const corpusRoot = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusRoot, { recursive: true });

const sessionToken = `BENCH-SESSION-TOKEN-${Date.now()}`;
const bookPhrase = 'Business-to-Business Direct Marketing';

await fs.writeFile(
  path.join(corpusRoot, 'small.md'),
  ['# Corpus', `Exact phrase: ${bookPhrase}.`, 'Additional line for retrieval tests.'].join('\n'),
);
await fs.writeFile(path.join(corpusRoot, 'large.txt'), (`${bookPhrase}\n` + 'chunk '.repeat(180)).repeat(600));

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

const commands = Object.fromEntries(regs.commands.map((c) => [c.name, c]));
for (const name of ['crag_recall', 'crag_corpus_ingest', 'crag_session_quote']) {
  assert.ok(commands[name] && typeof commands[name].handler === 'function', `${name} must register`);
}

const restoreFetch = installFetchMock();
const sessionId = 'benchmark-session-a';
for (let i = 0; i < 36; i += 1) {
  let content = `Turn ${i} generic context`;
  if (i === 4) content = `Remember this benchmark token exactly: ${sessionToken}`;
  await engine.ingest({
    sessionId,
    sessionKey: 'agent:main:benchmark-a',
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content },
  });
}

const assembled = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:benchmark-a',
  messages: [],
  tokenBudget: 2048,
});
assert.ok(Array.isArray(assembled?.messages), 'assemble messages should be array');
assert.ok(assembled.messages.length <= 20, 'assemble should remain bounded');
assert.ok(Number.isFinite(assembled?.estimatedTokens), 'estimatedTokens must be finite');
assert.ok(Number.isFinite(assembled?.totalTokens), 'totalTokens must be finite');

const ingestText = String(
  (
    await commands.crag_corpus_ingest.handler({
      args: [`--root ${corpusRoot} --max-files 4`],
    })
  )?.text ?? '',
);
const ingestedFilesMatch = ingestText.match(/ingested files:\s*(\d+)/i);
const interceptedFilesMatch = ingestText.match(/intercepted large files:\s*(\d+)/i);
const ingestedFiles = ingestedFilesMatch ? Number(ingestedFilesMatch[1]) : 0;
const interceptedFiles = interceptedFilesMatch ? Number(interceptedFilesMatch[1]) : 0;
assert.ok(
  ingestedFiles > 0 || interceptedFiles > 0,
  'corpus ingest should keep at least one source via normal chunks or large-file interception',
);

const sessionRecallText = String(
  (
    await commands.crag_recall.handler({
      args: [`--session-id ${sessionId} in this session what did we say about ${sessionToken}`],
      sessionId,
      sessionKey: 'agent:main:benchmark-a',
    })
  )?.text ?? '',
);
assert.match(sessionRecallText, /ranking intent:\s*session/i, 'session recall should use session intent');
assert.match(
  sessionRecallText,
  /winning source:\s*(lossless_session_raw|lossless_session_compact|backend_session_memory)/i,
  'session recall should choose session-oriented winner',
);
assert.match(sessionRecallText, /winning provenance:/i, 'session recall should include provenance');

const quoteText = String(
  (
    await commands.crag_session_quote.handler({
      args: [`--session-id ${sessionId} --exact ${sessionToken}`],
    })
  )?.text ?? '',
);
assert.match(quoteText, /exact mode:\s*yes/i, 'session quote should expose exact mode');
assert.match(quoteText, /raw exact\/near hits:\s*[1-9]/i, 'session quote should find exact hit');
assert.match(quoteText, /\[lossless_session_raw\]/i, 'session quote should include raw source marker');

const bookRecallText = String(
  (
    await commands.crag_recall.handler({
      args: [`--session-id ${sessionId} from book ${bookPhrase}`],
      sessionId,
      sessionKey: 'agent:main:benchmark-a',
    })
  )?.text ?? '',
);
assert.match(bookRecallText, /ranking intent:\s*corpus/i, 'book query should use corpus intent');
assert.match(bookRecallText, /winning source:\s*(large_file_excerpt|corpus_chunk)/i, 'book query should prefer corpus sources');
assert.match(bookRecallText, /winning provenance:/i, 'book query should include provenance');

restoreFetch();
console.log('memory quality benchmark invariants test passed');
