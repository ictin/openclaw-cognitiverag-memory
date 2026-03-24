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
  { name: "null-body", status: 200, body: null },
  { name: "empty-body", status: 200, body: {} },
  { name: "error-body", status: 500, body: { error: "backend failure" } },
  { name: "invalid-shape", status: 200, body: { weird: true } },
];

const originalFetch = globalThis.fetch;
const { api, engines } = makeApi();
const assemblyBodies = cases.map((c) => ({ ...c }));
let fetchIndex = 0;

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes("/session_assemble_context")) {
    const next = assemblyBodies[fetchIndex++];
    if (!next) throw new Error("unexpected extra assemble request");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};

register(api);
assert.equal(engines.length, 1);
const engine = engines[0].engine;

for (const c of cases) {
  const result = await engine.assemble({ sessionId: "fail-" + c.name, sessionKey: "key-" + c.name, tokenBudget: 1024, messages: [] });
  assert.equal(typeof result, "object", c.name);
  assert.ok(Array.isArray(result.messages), c.name);
  assert.ok(Number.isFinite(result.estimatedTokens), c.name);
  assert.ok(Number.isFinite(result.totalTokens), c.name);
}

if (originalFetch) globalThis.fetch = originalFetch;
console.log("isolated plugin failure harness ok");
