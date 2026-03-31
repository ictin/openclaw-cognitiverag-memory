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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-memory-intent-polish-'));
const corpusRoot = path.join(tmpDir, 'corpus');
await fs.mkdir(corpusRoot, { recursive: true });
await fs.writeFile(
  path.join(corpusRoot, 'NLP Book Summary.txt'),
  ['# NLP Book', 'Natural language processing covers tokenization, parsing, and retrieval workflows.'].join('\n'),
);
await fs.writeFile(
  path.join(corpusRoot, 'Psychology Notes.txt'),
  ['# Psychology Notes', 'Psychology memory includes cognition, behavior, and decision-making topics.'].join('\n'),
);

await fs.writeFile(
  path.join(tmpDir, 'MEMORY.md'),
  [
    '# MEMORY',
    '- Durable fact: we discussed NLP pipelines and retrieval.',
    '- Durable Validation Tokens (Opaque): CRAG-MEMORY-PROVE-XYZ-9999',
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
const cmd = Object.fromEntries(regs.commands.map((c) => [c.name, c]));
assert.ok(cmd.crag_corpus_ingest && typeof cmd.crag_corpus_ingest.handler === 'function', 'crag_corpus_ingest should register');

const restoreFetch = installFetchMock();
const sessionId = 'memory-intent-polish-session';

await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  message: { role: 'user', content: 'Remember this: NLP workstream includes retrieval ranking and provenance checks.' },
});
await engine.ingest({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  message: { role: 'assistant', content: 'Tool error residue: fetch failed ENOTFOUND example.invalid' },
});

await cmd.crag_corpus_ingest.handler({ args: [`--root ${corpusRoot} --max-files 4`] });

const rememberNlp = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'What do you remember about NLP?',
  messages: [{ role: 'user', content: 'What do you remember about NLP?' }],
  tokenBudget: 4096,
});
const rememberNlpSerialized = JSON.stringify(rememberNlp?.messages ?? []);
assert.match(rememberNlpSerialized, /HARD_SHORT_CIRCUIT_INTENT=memory_topic/i);
assert.match(rememberNlpSerialized, /Remembered evidence for topic:\s*NLP/i);
assert.doesNotMatch(rememberNlpSerialized, /Memory stack in use \(primary -> supporting\)/i);

const knowNlp = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'What do you know about NLP?',
  messages: [{ role: 'user', content: 'What do you know about NLP?' }],
  tokenBudget: 4096,
});
const knowPrompt = String(knowNlp?.systemPromptAddition ?? '');
assert.match(knowPrompt, /Natural answer routing intent:\s*knowledge/i);
assert.doesNotMatch(JSON.stringify(knowNlp?.messages ?? []), /HARD_SHORT_CIRCUIT_INTENT=memory_topic/i);

const memoryVsCorpus = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'What do you know from memory vs corpus about copywriting?',
  messages: [{ role: 'user', content: 'What do you know from memory vs corpus about copywriting?' }],
  tokenBudget: 4096,
});
const memoryVsCorpusSerialized = JSON.stringify(memoryVsCorpus?.messages ?? []);
assert.match(memoryVsCorpusSerialized, /HARD_SHORT_CIRCUIT_INTENT=architecture/i);

const rememberPsych = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'Do you remember anything about psychology?',
  messages: [{ role: 'user', content: 'Do you remember anything about psychology?' }],
  tokenBudget: 4096,
});
const rememberPsychSerialized = JSON.stringify(rememberPsych?.messages ?? []);
assert.match(rememberPsychSerialized, /HARD_SHORT_CIRCUIT_INTENT=memory_topic/i);
assert.match(
  rememberPsychSerialized,
  /Remembered evidence for topic:\s*psychology|do not currently have stored remembered evidence for \\\"psychology\\\"/i,
);

const completeBook = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'Do you remember any complete book?',
  messages: [{ role: 'user', content: 'Do you remember any complete book?' }],
  tokenBudget: 4096,
});
const completeSerialized = JSON.stringify(completeBook?.messages ?? []);
assert.match(completeSerialized, /HARD_SHORT_CIRCUIT_INTENT=memory_topic/i);
assert.match(completeSerialized, /do not store complete books as one monolithic memory item/i);
assert.match(completeSerialized, /chunked corpus\/large-file evidence/i);
assert.match(completeSerialized, /Retrieved remembered book examples:/i);

const rememberAll = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'What do you remember?',
  messages: [{ role: 'user', content: 'What do you remember?' }],
  tokenBudget: 4096,
});
const rememberAllSerialized = JSON.stringify(rememberAll?.messages ?? []);
assert.match(rememberAllSerialized, /HARD_SHORT_CIRCUIT_INTENT=memory_summary/i);
assert.doesNotMatch(rememberAllSerialized, /CRAG-MEMORY-PROVE-XYZ-9999/i);
assert.doesNotMatch(rememberAllSerialized, /ENOTFOUND|fetch failed/i);

const scorePrevious = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:memory-intent-polish',
  prompt: 'Score the previous output with a rubric and list top improvements.',
  messages: [{ role: 'user', content: 'Score the previous output with a rubric and list top improvements.' }],
  tokenBudget: 4096,
});
const scoreSerialized = JSON.stringify(scorePrevious?.messages ?? []);
assert.match(scoreSerialized, /HARD_SHORT_CIRCUIT_INTENT=architecture_overview/i);
assert.match(scoreSerialized, /No recent skill-guided execution is available to score yet/i);

restoreFetch();
console.log('memory intent routing polish test passed');
