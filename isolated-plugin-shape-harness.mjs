import assert from "node:assert/strict";
import register, { shapeAssembleResponse } from "./index.ts";

function makeResponse(body) {
  return {
    status: 200,
    body,
  };
}

const engineCalls = [];
const fetchCalls = [];
const responseQueue = [
  {
    context_block: {
      provenance: "ctx-provenance",
      exact_items: [{ content: "exact A", item_type: "x", exactness: "exact", summarizable: false }],
      derived_items: [{ summary: "derived B", item_type: "y", summarizable: true }],
    },
    fresh_tail: [{ sender: "assistant", text: "ignored tail" }],
    summaries: [{ summary: "ignored summary" }],
  },
  {
    fresh_tail: [
      { sender: "assistant", text: "hello" },
      { sender: "user", text: "world" },
    ],
    summaries: [{ summary: "old summary" }],
  },
  {
    fresh_tail: [],
    summaries: [],
  },
];

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!target.includes("/session_assemble_context")) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const body = JSON.parse(options.body);
  fetchCalls.push(body);
  const next = responseQueue.shift();
  if (!next) throw new Error("unexpected extra assemble call");
  return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
};

const api = {
  logger: { info() {}, warn() {} },
  config: { plugins: { slots: { contextEngine: "cognitiverag-memory" } } },
  registerContextEngine(name, factory) {
    engineCalls.push({ name, engine: factory() });
  },
  registerHttpRoute() {},
  registerCommand() {},
};

register(api);
assert.equal(engineCalls.length, 1);
const engine = engineCalls[0].engine;

const structured = await engine.assemble({ sessionId: "s1", sessionKey: "k1", tokenBudget: 1024, messages: [] });
assert.equal(fetchCalls.length, 1);
assert.deepEqual(fetchCalls[0], { session_id: "s1", fresh_tail_count: 20, budget: 1024 });
assert.equal(structured.messages.length, 2);
assert.equal(structured.messages[0].metadata.provenance, "ctx-provenance");
assert.equal(structured.systemPromptAddition, undefined);
assert.ok(Number.isFinite(structured.estimatedTokens));
assert.ok(Number.isFinite(structured.totalTokens));

const fallback = await engine.assemble({ sessionId: "s2", sessionKey: "k2", tokenBudget: 1024, messages: [] });
assert.equal(fetchCalls.length, 2);
assert.deepEqual(fetchCalls[1], { session_id: "s2", fresh_tail_count: 20, budget: 1024 });
assert.deepEqual(fallback.messages, [
  { role: "assistant", content: "hello" },
  { role: "user", content: "world" },
]);
assert.match(fallback.systemPromptAddition, /old summary/);
assert.ok(Number.isFinite(fallback.estimatedTokens));
assert.ok(Number.isFinite(fallback.totalTokens));

const empty = shapeAssembleResponse(makeResponse({ fresh_tail: [], summaries: [] }), 512);
assert.deepEqual(empty.messages, []);
assert.equal(empty.systemPromptAddition, undefined);
assert.equal(empty.estimatedTokens, 0);
assert.equal(empty.totalTokens, 0);

if (originalFetch) globalThis.fetch = originalFetch;
console.log("isolated plugin shape harness ok");
