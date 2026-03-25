import assert from 'node:assert/strict';
import register, { shapeAssembleResponse, toEngineAssembleResult } from './index.ts';

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

function assertEngineAssembleContract(result, label) {
  assert.equal(typeof result, 'object', label);
  assert.ok(result, label);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(result).includes('systemPromptAddition')
    ? ['estimatedTokens', 'messages', 'systemPromptAddition', 'totalTokens']
    : ['estimatedTokens', 'messages', 'totalTokens'], label);
  assert.ok(Array.isArray(result.messages), label);
  assert.equal(Number.isFinite(result.estimatedTokens), true, label);
  assert.equal(Number.isFinite(result.totalTokens), true, `${label}:totalTokens`);
  assert.ok(result.totalTokens >= result.estimatedTokens, `${label}:token-order`);
  for (const message of result.messages) {
    assert.equal(typeof message, 'object', `${label}:message`);
    assert.ok(message, `${label}:message`);
    assert.equal(typeof message.role, 'string', `${label}:role`);
    assert.ok(['user', 'assistant', 'system'].includes(message.role), `${label}:role:${message.role}`);
    assert.equal(typeof message.content, 'string', `${label}:content`);
    assert.ok(message.content.length > 0, `${label}:content-empty`);
  }
  if ('systemPromptAddition' in result) {
    assert.equal(typeof result.systemPromptAddition, 'string', `${label}:systemPromptAddition`);
    assert.ok(result.systemPromptAddition.length > 0, `${label}:systemPromptAddition-empty`);
  }
}

const originalFetch = globalThis.fetch;
const queue = [
  {
    status: 200,
    body: {
      context_block: {
        provenance: 'contract-provenance',
        exact_items: [{ content: 'exact contract', exactness: 'exact', summarizable: false }],
        derived_items: [{ summary: 'derived contract', summarizable: true }],
      },
      fresh_tail: [{ sender: 'assistant', text: 'ignored tail' }],
      summaries: [{ summary: 'ignored summary' }],
    },
  },
  {
    status: 200,
    body: {
      fresh_tail: [
        { sender: 'assistant', text: 'hello' },
        { sender: 'user', text: 'world' },
      ],
      summaries: [{ summary: 'older summary' }],
    },
  },
  {
    status: 500,
    body: { error: 'backend failure' },
  },
];

globalThis.fetch = async (url) => {
  const target = String(url);
  if (!target.includes('/session_assemble_context')) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const next = queue.shift();
  if (!next) throw new Error('unexpected extra assemble request');
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
};

const shaped = shapeAssembleResponse(
  {
    status: 200,
    body: {
      fresh_tail: [{ sender: 'assistant', text: 'shape only' }],
      summaries: [{ summary: 'shape summary' }],
    },
  },
  1024,
);
assert.equal(Number.isFinite(shaped.totalTokens), true, 'shape-totalTokens');
const engineShaped = toEngineAssembleResult(shaped);
assertEngineAssembleContract(engineShaped, 'shape-conversion');

const { api, engines } = createApi();
register(api);
assert.equal(engines.length, 1, 'engine-registered');
const engine = engines[0].engine;

const structured = await engine.assemble({ sessionId: 'c1', sessionKey: 'k1', tokenBudget: 1024, messages: [] });
assertEngineAssembleContract(structured, 'structured');

const fallback = await engine.assemble({ sessionId: 'c2', sessionKey: 'k2', tokenBudget: 1024, messages: [] });
assertEngineAssembleContract(fallback, 'fallback');

const failure = await engine.assemble({
  sessionId: 'c3',
  sessionKey: 'k3',
  tokenBudget: 1024,
  messages: [{ role: 'user', content: 'input fallback' }],
});
assertEngineAssembleContract(failure, 'failure');

if (originalFetch) {
  globalThis.fetch = originalFetch;
}

console.log('isolated plugin contract harness ok');
