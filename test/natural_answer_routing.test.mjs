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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-natural-routing-'));
const corpusRoot = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusRoot, { recursive: true });
await fs.writeFile(
  path.join(corpusRoot, 'YouTube Secrets by Nick Walsh - Synopsis.txt'),
  [
    '# YouTube Secrets by Nick Walsh',
    'This synopsis says to focus on niche clarity, hooks, upload consistency, and retention loops.',
    'It also highlights thumbnails, titles, and testing cadence for growth.',
  ].join('\n'),
);

await fs.writeFile(
  path.join(tmpDir, 'MEMORY.md'),
  ['# Fallback Mirror', '- Durable fact to remember exactly: NATURAL-ROUTING-TOKEN-123456'].join('\n'),
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
assert.ok(cmd.crag_corpus_ingest && typeof cmd.crag_corpus_ingest.handler === 'function', 'crag_corpus_ingest should register');

const restoreFetch = installFetchMock();
const sessionId = 'natural-routing-session';

await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  message: { role: 'user', content: 'Remember this durable fact for later: MY-NATURAL-FACT-42' },
});
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  message: { role: 'assistant', content: 'Saved both details for continuity.' },
});
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  message: { role: 'user', content: 'Please remember detailA=NL-DETAIL-A and detailB=NL-DETAIL-B' },
});

await cmd.crag_corpus_ingest.handler({ args: [`--root ${corpusRoot} --max-files 3`] });

const memorySummary = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  messages: [{ role: 'user', content: 'What do you remember?' }],
  tokenBudget: 4096,
});
const memoryPrompt = String(memorySummary?.systemPromptAddition ?? '');
assert.match(memoryPrompt, /Natural answer routing intent:\s*memory_summary/i, 'memory summary intent should auto-route');
assert.match(memoryPrompt, /Answer contract: provide a layered summary/i, 'memory summary contract should be present');
assert.match(memoryPrompt, /Do not dump raw token lists/i, 'memory summary should avoid raw token spam');
assert.match(memoryPrompt, /Hard format rule: use exactly 4 sections/i, 'memory summary should enforce layered sections');
assert.match(memoryPrompt, /Deterministic answer draft/i, 'memory summary should include deterministic draft');
assert.match(memoryPrompt, /Profile\/Preferences:/i, 'deterministic memory draft should include layered sections');
assert.match(
  memoryPrompt,
  /Deterministic final-answer contract for memory summary/i,
  'memory summary should include hard deterministic contract',
);
assert.match(
  JSON.stringify(memorySummary?.messages ?? []),
  /DETERMINISTIC_RESPONSE_MODE=memory_summary/i,
  'memory summary should enforce deterministic final response mode in user turn',
);

const corpusAnswer = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  messages: [{ role: 'user', content: 'What can you tell me about youtube secrets?' }],
  tokenBudget: 4096,
});
const corpusPrompt = String(corpusAnswer?.systemPromptAddition ?? '');
assert.match(corpusPrompt, /Natural answer routing intent:\s*corpus/i, 'corpus intent should auto-route');
assert.match(corpusPrompt, /Auto corpus evidence:/i, 'corpus evidence section should be present');
assert.match(corpusPrompt, /YouTube Secrets by Nick Walsh/i, 'corpus routing should include corpus evidence');
assert.match(corpusPrompt, /Top corpus evidence to use now:/i, 'corpus routing should expose top evidence');
assert.match(corpusPrompt, /Deterministic answer draft/i, 'corpus routing should include deterministic draft');
assert.match(corpusPrompt, /Retrieved corpus evidence:/i, 'corpus deterministic draft should include evidence block');
assert.match(
  corpusPrompt,
  /Deterministic final-answer contract for corpus overview/i,
  'corpus routing should include hard deterministic contract',
);
assert.match(
  JSON.stringify(corpusAnswer?.messages ?? []),
  /DETERMINISTIC_RESPONSE_MODE=corpus_overview/i,
  'corpus overview should enforce deterministic final response mode in user turn',
);

const wrappedCorpusAnswer = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'Sender (untrusted metadata):',
            '```json',
            '{',
            '  "label": "cli",',
            '  "id": "cli"',
            '}',
            '```',
            '',
            '[Fri 2026-03-27 17:28 GMT+1] What can you tell me about youtube secrets?',
          ].join('\n'),
        },
      ],
    },
  ],
  tokenBudget: 4096,
});
const wrappedCorpusPrompt = String(wrappedCorpusAnswer?.systemPromptAddition ?? '');
assert.match(
  wrappedCorpusPrompt,
  /Natural answer routing intent:\s*corpus/i,
  'wrapped metadata user prompts should still route to corpus intent',
);

const chatRecall = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  messages: [{ role: 'user', content: 'What did we say earlier about detailA?' }],
  tokenBudget: 4096,
});
const chatPrompt = String(chatRecall?.systemPromptAddition ?? '');
assert.match(chatPrompt, /Natural answer routing intent:\s*chat_recall/i, 'chat recall intent should auto-route');
assert.match(chatPrompt, /Auto session recall evidence:/i, 'chat recall evidence section should be present');

restoreFetch();
console.log('natural answer routing test passed');
