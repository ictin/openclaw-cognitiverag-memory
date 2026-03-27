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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-large-file-store-'));
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
assert.ok(engine, 'context engine must register');
const commandByName = Object.fromEntries(regs.commands.map((c) => [c?.name, c]));
for (const name of ['crag_corpus_ingest', 'crag_large_describe', 'crag_large_search', 'crag_large_excerpt', 'crag_recall']) {
  assert.ok(commandByName[name] && typeof commandByName[name].handler === 'function', `${name} command must register`);
}

const restoreFetch = installBackendMock();

const corpusRoot = path.join(tmpDir, 'fixtures');
await fs.mkdir(corpusRoot, { recursive: true });
const smallFile = path.join(corpusRoot, 'small-note.txt');
const largeFile = path.join(corpusRoot, 'large-corpus.txt');
const exactPhrase = 'LARGE-FILE-EXACT-ANCHOR-ALPHA-92921';
const semanticPhrase = 'progressive context compression with expandable excerpts';

await fs.writeFile(
  smallFile,
  [
    'Small note',
    'This file should stay in normal corpus chunks and provide enough deterministic text to pass minimum size guards.',
    'It is intentionally smaller than the large-file threshold but long enough for normal chunking behavior in the corpus layer.',
  ].join('\n'),
);

const repeatedBlock = [
  `This large file stores exact anchor phrase: ${exactPhrase}.`,
  `It also discusses ${semanticPhrase} for retrieval quality.`,
  'Additional filler content to exceed the large-file threshold while remaining deterministic.',
].join('\n');
await fs.writeFile(largeFile, `${repeatedBlock}\n`.repeat(4200));
const largeStat = await fs.stat(largeFile);
assert.ok(Number(largeStat.size) > 512 * 1024, 'fixture must exceed large-file threshold');

const ingestRes = await commandByName.crag_corpus_ingest.handler({
  args: [`--root ${corpusRoot} --max-files 5`],
});
assert.equal(typeof ingestRes?.text, 'string', 'ingest result must be text');
assert.match(ingestRes.text, /intercepted large files:\s*1/i, 'one oversized file should be intercepted');
assert.match(ingestRes.text, /ingested files:\s*1/i, 'one small file should remain in normal corpus');
assert.match(ingestRes.text, /large file index:/i, 'large file index path should be reported');

const largeDescribe = await commandByName.crag_large_describe.handler({});
assert.equal(typeof largeDescribe?.text, 'string', 'large describe must return text');
assert.match(largeDescribe.text, /docs:\s*1/i, 'large-file store should contain one doc');
assert.match(largeDescribe.text, /excerpts:\s*[1-9]/i, 'large-file store should contain excerpts');

const largeSearchExact = await commandByName.crag_large_search.handler({ args: [exactPhrase] });
assert.equal(typeof largeSearchExact?.text, 'string', 'large search exact must return text');
assert.match(largeSearchExact.text, /hits:\s*[1-9]/i, 'exact anchor should return large-file hits');
assert.match(largeSearchExact.text, /\[large_file_excerpt\]/i, 'large-file provenance marker must be present');
assert.match(largeSearchExact.text, /span\s+\d+\-\d+/i, 'large-file hit should expose span locator');

const excerptIdMatch = largeSearchExact.text.match(/[a-f0-9]{16}:\d+/i);
assert.ok(excerptIdMatch?.[0], 'search output should expose excerpt id');
const largeExcerpt = await commandByName.crag_large_excerpt.handler({ args: [excerptIdMatch[0]] });
assert.equal(typeof largeExcerpt?.text, 'string', 'large excerpt command must return text');
assert.match(largeExcerpt.text, /source path:/i, 'large excerpt should include source path');
assert.match(largeExcerpt.text, new RegExp(exactPhrase), 'large excerpt should include exact phrase');

const largeSearchSemantic = await commandByName.crag_large_search.handler({ args: ['expandable excerpts retrieval quality'] });
assert.equal(typeof largeSearchSemantic?.text, 'string', 'large search semantic must return text');
assert.match(largeSearchSemantic.text, /hits:\s*[1-9]/i, 'semantic query should return hits');

const recallRes = await commandByName.crag_recall.handler({ args: [exactPhrase] });
assert.equal(typeof recallRes?.text, 'string', 'crag_recall should return text');
assert.match(recallRes.text, /large file hits:\s*[1-9]/i, 'crag_recall should report large-file hits');
assert.match(recallRes.text, /\[large_file_excerpt\]/i, 'crag_recall should include large-file provenance');

const assembled = await engine.assemble({
  sessionId: 'large-file-session',
  sessionKey: 'agent:main:large-file-session',
  messages: [],
  tokenBudget: 2048,
});
assert.ok(Array.isArray(assembled?.messages), 'assemble should return message array');
assert.ok(assembled.messages.length <= 20, 'assemble should remain bounded');
assert.ok(Number.isFinite(assembled?.totalTokens), 'assemble totalTokens should stay finite');

// Restart plugin and ensure large-file store remains queryable.
const regsAfterRestart = { commands: [], engines: {} };
const apiAfterRestart = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (cmd) => regsAfterRestart.commands.push(cmd),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regsAfterRestart.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
  logger: { info: () => {}, warn: () => {} },
};
register(apiAfterRestart);
const largeSearchAfterRestart = regsAfterRestart.commands.find((c) => c?.name === 'crag_large_search');
assert.ok(largeSearchAfterRestart && typeof largeSearchAfterRestart.handler === 'function', 'large search should register after restart');
const postRestartRes = await largeSearchAfterRestart.handler({ args: [exactPhrase] });
assert.equal(typeof postRestartRes?.text, 'string', 'post-restart large search must return text');
assert.match(postRestartRes.text, /hits:\s*[1-9]/i, 'post-restart large search should still find matches');

restoreFetch();
console.log('large file store test passed');
