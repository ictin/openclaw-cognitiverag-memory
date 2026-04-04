import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import register from '../index.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-fail-closed-compat-'));
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
assert.ok(engine && typeof engine.assemble === 'function', 'context engine should register');

const seenRequests = [];
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (u.endsWith('/session_assemble_context')) {
    seenRequests.push(body);
    throw new Error('fetch failed');
  }
  if (u.endsWith('/session_append_message')) return { status: 200, async json() { return { status: 'inserted' }; } };
  if (u.endsWith('/session_append_message_part')) return { status: 200, async json() { return { status: 'inserted' }; } };
  if (u.endsWith('/session_upsert_context_item')) return { status: 200, async json() { return { status: 'inserted' }; } };
  throw new Error(`unexpected URL: ${u}`);
};

try {
  const corpusPrompt =
    'Do you have any books on NLP hypnosis? Answer only from memory/corpus, and say "no evidence found" if none.';
  const corpusOut = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: corpusPrompt,
    messages: [{ role: 'user', content: corpusPrompt }],
    tokenBudget: 4096,
  });
  assert.equal(seenRequests.at(-1)?.intent_family, 'corpus_overview');
  const corpusText = JSON.stringify(corpusOut?.messages ?? []);
  assert.match(corpusText, /HARD_SHORT_CIRCUIT_INTENT=corpus_overview/i);
  assert.match(corpusText, /no evidence found\./i);
  assert.match(corpusText, /No corpus\/memory evidence was available in this turn\./i);
  assert.doesNotMatch(corpusText, /I can.?t access real-time data directly|I can.?t see live prices directly/i);
  const corpusRepeat = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: corpusPrompt,
    messages: [{ role: 'user', content: corpusPrompt }],
    tokenBudget: 4096,
  });
  assert.equal(JSON.stringify(corpusRepeat?.messages ?? []), corpusText, 'corpus fail-closed wording should stay stable');

  const memoryPrompt =
    'What do you remember from this conversation? Keep it short and tell me what is mirror-only versus backend memory.';
  const memoryOut = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: memoryPrompt,
    messages: [{ role: 'user', content: memoryPrompt }],
    tokenBudget: 4096,
  });
  const memoryText = JSON.stringify(memoryOut?.messages ?? []);
  assert.match(memoryText, /HARD_SHORT_CIRCUIT_INTENT=memory_summary/i);
  assert.match(memoryText, /Backend\/session memory is canonical memory for this system\./i);
  assert.match(memoryText, /Markdown mirrors are support\/export\/debug summaries only, not canonical backend memory\./i);
  assert.match(memoryText, /no evidence found beyond those architecture-level truths/i);
  const memoryRepeat = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: memoryPrompt,
    messages: [{ role: 'user', content: memoryPrompt }],
    tokenBudget: 4096,
  });
  assert.equal(JSON.stringify(memoryRepeat?.messages ?? []), memoryText, 'memory fail-closed wording should stay stable');

  const architecturePrompt =
    'If older session memory was compacted, does that mean it was lost? Answer briefly and truthfully.';
  const architectureOut = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: architecturePrompt,
    messages: [{ role: 'user', content: architecturePrompt }],
    tokenBudget: 4096,
  });
  const architectureText = JSON.stringify(architectureOut?.messages ?? []);
  assert.match(architectureText, /HARD_SHORT_CIRCUIT_INTENT=architecture/i);
  assert.match(architectureText, /Backend\/session memory remains canonical; mirrors remain support\/export\/debug only\./i);
  assert.match(architectureText, /Compacted session memory is treated as recoverable lineage-linked memory, not as silent loss\./i);

  const genericPrompt = 'Give me useful info.';
  const genericOut = await engine.assemble({
    sessionId: 'compat-fail-closed-session',
    sessionKey: 'agent:main:compat-fail-closed',
    prompt: genericPrompt,
    messages: [{ role: 'user', content: genericPrompt }],
    tokenBudget: 4096,
  });
  assert.equal(seenRequests.at(-1)?.intent_family ?? null, null);
  assert.equal(genericOut?.messages?.[0]?.role, 'user');
  const genericContent = JSON.stringify(genericOut?.messages?.[0]?.content ?? null);
  assert.match(genericContent, /Give me useful info\./i, 'generic backend failure should preserve the generic user prompt');
  const genericText = JSON.stringify(genericOut?.messages ?? []);
  assert.doesNotMatch(genericText, /HARD_SHORT_CIRCUIT_INTENT=/i);
  assert.doesNotMatch(genericText, /no evidence found\.|web retrieval failed for this price query/i);
} finally {
  global.fetch = realFetch;
}

console.log('evidence-sensitive fail-closed compatibility test passed');
