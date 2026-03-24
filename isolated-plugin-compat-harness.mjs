import assert from "node:assert/strict";
import register from "./index.ts";

function makeApi() {
  const engines = [];
  return {
    engines,
    api: {
      logger: { info() {}, warn() {} },
      config: { plugins: { slots: { contextEngine: "cognitiverag-memory" } } },
      registerContextEngine(name, factory) {
        engines.push({ name, engine: factory() });
      },
      registerHttpRoute() {},
      registerCommand() {},
    },
  };
}

const cases = [
  {
    name: "structured backend response",
    body: {
      context_block: {
        provenance: "compat-provenance",
        exact_items: [{ content: "exact compat", exactness: "exact", summarizable: false }],
        derived_items: [{ summary: "derived compat", summarizable: true }],
      },
      fresh_tail: [{ sender: "assistant", text: "ignored compat tail" }],
      summaries: [{ summary: "ignored compat summary" }],
    },
  },
  {
    name: "fallback backend response",
    body: {
      fresh_tail: [
        { sender: "assistant", text: "hello" },
        { sender: "user", text: "world" },
      ],
      summaries: [{ summary: "old compat summary" }],
    },
  },
  {
    name: "empty backend response",
    body: { fresh_tail: [], summaries: [] },
  },
  { name: "null body", body: null },
  { name: "empty body {}", body: {} },
  { name: "status 500 body", body: { error: "backend failure" }, status: 500 },
  { name: "invalid shape body", body: { weird: true } },
  { name: "fetch throws", throws: new Error("fetch failure") },
  { name: "fetch abort/timeout-like throw", throws: Object.assign(new Error("The operation was aborted."), { name: "AbortError" }) },
];

const originalFetch = globalThis.fetch;
const { api, engines } = makeApi();
let index = 0;

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!target.includes("/session_assemble_context")) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const next = cases[index++];
  if (!next) throw new Error("unexpected extra assemble request");
  if (next.throws) throw next.throws;
  return new Response(JSON.stringify(next.body), {
    status: next.status ?? 200,
    headers: { "content-type": "application/json" },
  });
};

register(api);
assert.equal(engines.length, 1);
const engine = engines[0].engine;

for (const c of cases) {
  const result = await engine.assemble({ sessionId: `compat-${c.name}`, sessionKey: `key-${c.name}`, tokenBudget: 1024, messages: [] });
  assert.equal(typeof result, "object", c.name);
  assert.ok(Array.isArray(result.messages), c.name);
  assert.ok(Number.isFinite(result.estimatedTokens), c.name);
  assert.ok(Number.isFinite(result.totalTokens), c.name);
}

if (originalFetch) globalThis.fetch = originalFetch;
console.log("isolated plugin compat harness ok");
