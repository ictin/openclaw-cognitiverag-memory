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
  path.join(corpusRoot, 'Robert Bly - Book Synopsis.txt'),
  [
    '# Robert Bly Overview',
    'This synopsis focuses on direct response advertising ideas and copywriting themes.',
    'It is unrelated to YouTube retention loops and thumbnail testing cadence.',
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
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  message: { role: 'user', content: 'Earlier we asked about YouTube Secrets and its synopsis.' },
});

await cmd.crag_corpus_ingest.handler({ args: [`--root ${corpusRoot} --max-files 3`] });

const memorySummary = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'What do you remember?',
  messages: [{ role: 'user', content: 'What do you remember?' }],
  tokenBudget: 4096,
});
const memoryPrompt = String(memorySummary?.systemPromptAddition ?? '');
assert.equal(memoryPrompt, '', 'memory summary hard short-circuit should clear additive prompt text');
assert.match(
  JSON.stringify(memorySummary?.messages ?? []),
  /HARD_SHORT_CIRCUIT_INTENT=memory_summary/i,
  'memory summary should use hard short-circuit deterministic mode',
);
assert.match(
  JSON.stringify(memorySummary?.messages ?? []),
  /BEGIN_FINAL_ANSWER[\s\S]*Memory stack in use \(primary -> supporting\):/i,
  'memory summary deterministic payload should include layered final answer body',
);
assert.equal((memorySummary?.messages ?? []).length, 2, 'memory summary short-circuit should forward only deterministic system+user pair');

const corpusAnswer = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'What can you tell me about youtube secrets?',
  messages: [{ role: 'user', content: 'What can you tell me about youtube secrets?' }],
  tokenBudget: 4096,
});
const corpusPrompt = String(corpusAnswer?.systemPromptAddition ?? '');
assert.equal(corpusPrompt, '', 'corpus hard short-circuit should clear additive prompt text');
assert.match(
  JSON.stringify(corpusAnswer?.messages ?? []),
  /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i,
  'corpus overview should use hard short-circuit deterministic mode',
);
assert.match(
  JSON.stringify(corpusAnswer?.messages ?? []),
  /BEGIN_FINAL_ANSWER[\s\S]*Retrieved corpus evidence:/i,
  'corpus deterministic payload should include retrieved evidence content',
);
const corpusSerialized = JSON.stringify(corpusAnswer?.messages ?? []);
const ytPos = corpusSerialized.toLowerCase().indexOf('youtube secrets');
const blyPos = corpusSerialized.toLowerCase().indexOf('robert bly');
assert.ok(ytPos >= 0, 'corpus deterministic payload should include YouTube Secrets evidence');
if (blyPos >= 0) {
  assert.ok(ytPos < blyPos, 'YouTube evidence should rank ahead of unrelated synopsis evidence');
}
assert.equal((corpusAnswer?.messages ?? []).length, 2, 'corpus overview short-circuit should forward only deterministic system+user pair');

const synopsisAnswer = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'What does the synopsis say?',
  messages: [{ role: 'user', content: 'What does the synopsis say?' }],
  tokenBudget: 4096,
});
const synopsisSerialized = JSON.stringify(synopsisAnswer?.messages ?? []);
assert.match(synopsisSerialized, /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i);
assert.match(synopsisSerialized, /youtube secrets/i, 'synopsis follow-up should carry forward prior corpus topic context');

const wrappedCorpusAnswer = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'What can you tell me about youtube secrets?',
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
assert.equal(wrappedCorpusPrompt, '', 'wrapped corpus prompt should also hard short-circuit');
assert.match(JSON.stringify(wrappedCorpusAnswer?.messages ?? []), /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i);

const chatRecall = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'What did we say earlier about detailA?',
  messages: [{ role: 'user', content: 'What did we say earlier about detailA?' }],
  tokenBudget: 4096,
});
const chatPrompt = String(chatRecall?.systemPromptAddition ?? '');
assert.match(chatPrompt, /Natural answer routing intent:\s*chat_recall/i, 'chat recall intent should auto-route');
assert.match(chatPrompt, /Auto session recall evidence:/i, 'chat recall evidence section should be present');

const architecture = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'Do you use CRAG lossless memory?',
  messages: [{ role: 'user', content: 'Do you use CRAG lossless memory?' }],
  tokenBudget: 4096,
});
const architecturePrompt = String(architecture?.systemPromptAddition ?? '');
assert.equal(architecturePrompt, '', 'architecture overview should also hard short-circuit deterministic mode');
assert.match(JSON.stringify(architecture?.messages ?? []), /HARD_SHORT_CIRCUIT_INTENT=architecture_overview/i);
assert.match(JSON.stringify(architecture?.messages ?? []), /CRAG\/lossless memory is active/i);

const evidenceSources = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:natural-routing',
  prompt: 'For this topic, which evidence sources would you check next: session memory, promoted memory, corpus, or web?',
  messages: [
    {
      role: 'user',
      content:
        'For this topic, which evidence sources would you check next: session memory, promoted memory, corpus, or web?',
    },
  ],
  tokenBudget: 4096,
});
const evidencePrompt = String(evidenceSources?.systemPromptAddition ?? '');
assert.equal(evidencePrompt, '', 'evidence-source query should use architecture deterministic short-circuit');
assert.match(
  JSON.stringify(evidenceSources?.messages ?? []),
  /HARD_SHORT_CIRCUIT_INTENT=architecture_overview/i,
);
assert.match(
  JSON.stringify(evidenceSources?.messages ?? []),
  /Evidence-source order for this topic[\s\S]*session memory[\s\S]*promoted memory[\s\S]*corpus\/large-file[\s\S]*web memory/i,
);
assert.match(
  JSON.stringify(evidenceSources?.messages ?? []),
  /raw web evidence[\s\S]*web promoted memory/i,
);

restoreFetch();
console.log('natural answer routing test passed');
