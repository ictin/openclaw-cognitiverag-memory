import assert from 'node:assert/strict';
import register, { shapeAssembleResponse, toEngineAssembleResult } from '../index.js';

function makeEngine() {
  const regs = { contextEngines: {} };
  const api = {
    registerCommand: () => {},
    registerHttpRoute: () => {},
    registerContextEngine: (id, factory) => {
      regs.contextEngines[id] = factory();
    },
    config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
  };
  register(api);
  return regs.contextEngines['cognitiverag-memory'];
}

function installFetchMock(handler) {
  const realFetch = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = realFetch;
  };
}

function makeFetchResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function assertSafeAssembleBoundary(result) {
  assert.ok(result && typeof result === 'object', 'assemble must return an object');
  assert.ok(Array.isArray(result.messages), 'messages must be an array');
  assert.ok(Number.isFinite(result.estimatedTokens), 'estimatedTokens must be finite');
  assert.ok(result.estimatedTokens >= 0, 'estimatedTokens must be >= 0');
  assert.ok(Number.isFinite(result.totalTokens), 'totalTokens must be finite');
  assert.ok(result.totalTokens >= 0, 'totalTokens must be >= 0');
  assert.ok(result.usage && typeof result.usage === 'object', 'usage object must be present');
  assert.ok(Number.isFinite(result.usage.totalTokens), 'usage.totalTokens must be finite');
  assert.ok(Number.isFinite(result.usage.estimatedTokens), 'usage.estimatedTokens must be finite');
  assert.ok(result.source && typeof result.source === 'object', 'source object must be present');
  assert.ok(Number.isFinite(result.source.totalTokens), 'source.totalTokens must be finite');
  assert.ok(Number.isFinite(result.source.estimatedTokens), 'source.estimatedTokens must be finite');
}

function hostReadsTotalsLikeAggregator(result) {
  // Regression guard for live failure class:
  // Cannot read properties of undefined (reading 'totalTokens')
  return result.source.totalTokens + result.usage.totalTokens + result.totalTokens;
}

const engine = makeEngine();
assert.ok(engine && typeof engine.assemble === 'function', 'context engine assemble should be registered');

// A1. Happy path
{
  const restore = installFetchMock(async () =>
    makeFetchResponse(200, { fresh_tail: [{ sender: 'user', text: 'hello' }], summaries: [{ summary: 'older' }] }),
  );
  const result = await engine.assemble({ sessionId: 'a1', messages: [] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.ok(result.messages.length > 0, 'happy path should provide messages');
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A2. Empty backend body object
{
  const restore = installFetchMock(async () => makeFetchResponse(200, {}));
  const result = await engine.assemble({ sessionId: 'a2', messages: [] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A3. Null backend body
{
  const restore = installFetchMock(async () => makeFetchResponse(200, null));
  const result = await engine.assemble({ sessionId: 'a3', messages: [] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A4/A5. Missing fields + malformed field types
{
  const restore = installFetchMock(async () =>
    makeFetchResponse(200, { fresh_tail: 'bad', summaries: 42, context_block: { exact_items: 'x', derived_items: null } }),
  );
  const result = await engine.assemble({ sessionId: 'a4a5', messages: [] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A6. Backend fetch throw
{
  const restore = installFetchMock(async () => {
    throw new Error('simulated backend throw');
  });
  const result = await engine.assemble({ sessionId: 'a6', messages: [{ role: 'user', content: 'fallback' }] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A7/A8. Non-200 with missing usage-ish backend details
{
  const restore = installFetchMock(async () => makeFetchResponse(503, { error: 'down', summaries: null }));
  const result = await engine.assemble({ sessionId: 'a7a8', messages: [] });
  restore();
  assertSafeAssembleBoundary(result);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
}

// A9. Direct boundary adapter must never leak undefined totals
{
  const adapted = toEngineAssembleResult(
    shapeAssembleResponse({ status: 200, body: { fresh_tail: [], summaries: [] } }, 1024),
  );
  assertSafeAssembleBoundary(adapted);
  assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(adapted));
}

// C. Multi-turn repeated use: deterministic safe shape across varied backend responses
{
  let i = 0;
  const sequence = [
    () => makeFetchResponse(200, { fresh_tail: [{ sender: 'user', text: 'hi' }], summaries: [] }),
    () => makeFetchResponse(200, {}),
    () => makeFetchResponse(200, null),
    () => makeFetchResponse(500, { error: 'server' }),
    () => makeFetchResponse(200, { fresh_tail: 'bad', summaries: [{ summary: 123 }] }),
  ];
  const restore = installFetchMock(async () => sequence[(i++) % sequence.length]());

  const requiredKeys = ['estimatedTokens', 'messages', 'source', 'totalTokens', 'usage'];
  for (let n = 0; n < 25; n += 1) {
    const result = await engine.assemble({
      sessionId: `repeat-${n}`,
      messages: n % 2 ? [{ role: 'user', content: `msg-${n}` }] : [],
      tokenBudget: 1024 + n,
    });
    assertSafeAssembleBoundary(result);
    const keys = Object.keys(result).sort();
    for (const key of requiredKeys) {
      assert.ok(keys.includes(key), `assemble result missing required key: ${key}`);
    }
    assert.ok(
      keys.every((key) => requiredKeys.includes(key) || key === 'systemPromptAddition'),
      'assemble result contains unexpected top-level keys',
    );
    assert.doesNotThrow(() => hostReadsTotalsLikeAggregator(result));
  }

  restore();
}

console.log('assemble regression tests passed');
