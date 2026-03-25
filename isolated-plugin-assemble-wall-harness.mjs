import assert from 'node:assert/strict';
import register from './index.ts';

function createApi() {
  const engines = [];
  return {
    engines,
    api: {
      logger: { info() {}, warn() {} },
      config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
      registerContextEngine(name, factory) {
        engines.push({ name, engine: factory() });
      },
      registerHttpRoute() {},
      registerCommand() {},
    },
  };
}

const responseQueue = [
  {
    kind: 'json',
    status: 200,
    body: {
      context_block: {
        provenance: 'wall-provenance',
        exact_items: [{ content: 'exact wall item', item_type: 'fact', exactness: 'exact', summarizable: false }],
        derived_items: [{ summary: 'derived wall item', item_type: 'summary', summarizable: true }],
      },
      fresh_tail: [{ sender: 'assistant', text: 'ignored tail' }],
      summaries: [{ summary: 'ignored summary' }],
    },
  },
  {
    kind: 'json',
    status: 200,
    body: {
      fresh_tail: [
        { sender: 'assistant', text: 'hello' },
        { sender: 'user', text: 'world' },
      ],
      summaries: [{ summary: 'old summary' }],
    },
  },
  {
    kind: 'json',
    status: 200,
    body: null,
  },
  {
    kind: 'json',
    status: 200,
    body: {},
  },
  {
    kind: 'text',
    status: 200,
    body: 'not-json',
  },
  {
    kind: 'json',
    status: 500,
    body: { error: 'backend failure' },
  },
];

const fetchBodies = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.includes('/session_assemble_context')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  fetchBodies.push(JSON.parse(options.body));
  const next = responseQueue.shift();
  if (!next) {
    throw new Error('unexpected extra assemble call');
  }

  if (next.kind === 'text') {
    return new Response(next.body, {
      status: next.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
};

const { api, engines } = createApi();
register(api);
assert.equal(engines.length, 1);
const engine = engines[0].engine;

const structured = await engine.assemble({ sessionId: 's1', sessionKey: 'k1', tokenBudget: 1024, messages: [] });
assert.deepEqual(structured.messages.map((m) => [m.role, m.content]), [
  ['user', 'exact wall item'],
  ['system', 'derived wall item'],
]);
assert.equal(structured.systemPromptAddition, undefined);
assert.ok(Number.isFinite(structured.estimatedTokens));
assert.equal(Number.isFinite(structured.totalTokens), true);
assert.ok(structured.totalTokens >= structured.estimatedTokens);

const fallback = await engine.assemble({ sessionId: 's2', sessionKey: 'k2', tokenBudget: 1024, messages: [] });
assert.deepEqual(fallback.messages, [
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'world' },
]);
assert.match(fallback.systemPromptAddition, /old summary/);
assert.ok(Number.isFinite(fallback.estimatedTokens));
assert.equal(Number.isFinite(fallback.totalTokens), true);
assert.ok(fallback.totalTokens >= fallback.estimatedTokens);

for (const sessionId of ['s3', 's4', 's5', 's6']) {
  const result = await engine.assemble({
    sessionId,
    sessionKey: `key-${sessionId}`,
    tokenBudget: 1024,
    messages: [{ role: 'user', content: 'input fallback should not leak on parse failure' }],
  });
  assert.equal(typeof result, 'object', sessionId);
  assert.ok(Array.isArray(result.messages), sessionId);
  assert.equal(Number.isFinite(result.estimatedTokens), true, sessionId);
  assert.equal(Number.isFinite(result.totalTokens), true, sessionId);
  assert.ok(result.totalTokens >= result.estimatedTokens, sessionId);
}

assert.deepEqual(
  fetchBodies,
  [
    { session_id: 's1', fresh_tail_count: 20, budget: 1024 },
    { session_id: 's2', fresh_tail_count: 20, budget: 1024 },
    { session_id: 's3', fresh_tail_count: 20, budget: 1024 },
    { session_id: 's4', fresh_tail_count: 20, budget: 1024 },
    { session_id: 's5', fresh_tail_count: 20, budget: 1024 },
    { session_id: 's6', fresh_tail_count: 20, budget: 1024 },
  ],
);

if (originalFetch) {
  globalThis.fetch = originalFetch;
}

console.log('isolated plugin assemble wall harness ok');
