import assert from 'node:assert/strict';
import register from './index.ts';

const assemblyCalls = [];
const modules = [];

const api = {
  logger: {
    info() {},
    warn() {},
  },
  config: {
    plugins: {
      slots: {
        contextEngine: 'cognitiverag-memory',
      },
    },
  },
  registerContextEngine(name, factory) {
    modules.push({ name, engine: factory() });
  },
  registerHttpRoute() {},
};

const responseQueue = [
  {
    context_block: {
      provenance: 'ctx-provenance',
      exact_items: [{ content: 'exact A', item_type: 'x', exactness: 'exact', summarizable: false }],
      derived_items: [{ summary: 'derived B', item_type: 'y', summarizable: true }],
    },
    fresh_tail: [{ sender: 'assistant', text: 'ignored tail' }],
    summaries: [{ summary: 'ignored summary' }],
  },
  {
    fresh_tail: [
      { sender: 'assistant', text: 'hello' },
      { sender: 'user', text: 'world' },
    ],
    summaries: [{ summary: 'old summary' }],
  },
];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('/session_assemble_context')) {
    assemblyCalls.push(JSON.parse(options.body));
    const next = responseQueue.shift();
    if (!next) throw new Error('unexpected extra assemble call');
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

register(api);

assert.equal(modules.length, 1, 'context engine not registered');
assert.equal(modules[0].name, 'cognitiverag-memory');
const engine = modules[0].engine;
assert.equal(typeof engine.assemble, 'function');

const structured = await engine.assemble({ sessionId: 's1', tokenBudget: 1024, messages: [] });
assert.equal(structured.messages.length, 2);
assert.equal(structured.messages[0].metadata.provenance, 'ctx-provenance');
assert.equal(structured.systemPromptAddition, undefined);
assert.equal(structured.totalTokens, structured.estimatedTokens);

const fallback = await engine.assemble({ sessionId: 's2', tokenBudget: 1024, messages: [] });
assert.deepEqual(fallback.messages, [
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'world' },
]);
assert.match(fallback.systemPromptAddition, /old summary/);
assert.equal(fallback.totalTokens, fallback.estimatedTokens);
assert.equal(assemblyCalls.length, 2);
assert.deepEqual(assemblyCalls.map((c) => c.session_id), ['s1', 's2']);

if (originalFetch) globalThis.fetch = originalFetch;
console.log('registration harness ok');
