import assert from 'node:assert/strict';
import register from './index.ts';

function createApi() {
  const engines = [];
  const routes = [];
  const commands = [];
  const logs = [];

  return {
    engines,
    routes,
    commands,
    logs,
    api: {
      logger: {
        info(...args) {
          logs.push({ level: 'info', args });
        },
        warn(...args) {
          logs.push({ level: 'warn', args });
        },
      },
      config: {
        plugins: {
          slots: {
            contextEngine: 'cognitiverag-memory',
          },
        },
      },
      registerContextEngine(name, factory) {
        engines.push({ name, engine: factory() });
      },
      registerHttpRoute(route) {
        routes.push(route);
      },
      registerCommand(command) {
        commands.push(command);
      },
    },
  };
}

function createResponseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      this.body = String(body ?? '');
    },
  };
}

const fetchCalls = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const body = options.body ? JSON.parse(options.body) : null;
  fetchCalls.push({ target, body });

  if (target.includes('/session_assemble_context')) {
    return new Response(JSON.stringify({ fresh_tail: [], summaries: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (target.includes('/session_append_message')) {
    const ok = body?.session_id === 'ingest-ok';
    return new Response(JSON.stringify({ status: ok ? 'inserted' : 'rejected' }), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (target.includes('/session_append_message_part')) {
    return new Response(JSON.stringify({ status: 'inserted' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (target.includes('/session_upsert_context_item')) {
    return new Response(JSON.stringify({ status: 'updated' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  throw new Error(`unexpected fetch target: ${target}`);
};

const { api, engines, routes, commands } = createApi();
register(api);

assert.equal(engines.length, 1, 'expected one context engine');
assert.equal(engines[0].name, 'cognitiverag-memory');

assert.deepEqual(
  commands.map((command) => command.name).sort(),
  ['crag-remember', 'crag-status', 'remember'],
  'expected command registrations',
);

assert.deepEqual(
  routes.map((route) => route.path).sort(),
  ['/cognitiverag-memory/health', '/cognitiverag-memory/status'],
  'expected health/status routes only once each',
);

const engine = engines[0].engine;
assert.equal(engine.info.id, 'cognitiverag-memory');

const assembled = await engine.assemble({
  sessionId: 'assemble-ok',
  sessionKey: 'assemble-key',
  tokenBudget: 1024,
  messages: [],
});
assert.deepEqual(assembled, {
  messages: [],
  estimatedTokens: 0,
  totalTokens: 0,
});

const ingestOk = await engine.ingest({
  sessionId: 'ingest-ok',
  sessionKey: 'key-ok',
  message: { role: 'assistant', content: 'stored text' },
});
assert.deepEqual(ingestOk, { ingested: true });

const ingestFail = await engine.ingest({
  sessionId: 'ingest-fail',
  sessionKey: 'key-fail',
  message: { role: 'user', content: 'rejected text' },
});
assert.deepEqual(ingestFail, { ingested: false });

const assembleCalls = fetchCalls.filter((call) => call.target.includes('/session_assemble_context'));
const appendMessageCalls = fetchCalls.filter((call) => call.target.includes('/session_append_message'));
const appendPartCalls = fetchCalls.filter((call) => call.target.includes('/session_append_message_part'));
const upsertCalls = fetchCalls.filter((call) => call.target.includes('/session_upsert_context_item'));

assert.equal(assembleCalls.length, 1);
assert.deepEqual(assembleCalls[0].body, { session_id: 'assemble-ok', fresh_tail_count: 20, budget: 1024 });
assert.equal(appendMessageCalls.length, 2);
assert.equal(appendPartCalls.length, 2);
assert.equal(upsertCalls.length, 2);
assert.equal(appendMessageCalls[0].body.sender, 'assistant');
assert.equal(appendMessageCalls[1].body.sender, 'user');

for (const route of routes) {
  const res = createResponseRecorder();
  const handled = await route.handler({}, res);
  assert.equal(handled, true, route.path);
  assert.equal(res.statusCode, 200, route.path);
  assert.match(String(res.headers['content-type'] ?? ''), /application\/json/, route.path);
  const payload = JSON.parse(res.body);
  assert.equal(payload.pluginLoaded, true, route.path);
  assert.equal(payload.contextEngineSlot, 'cognitiverag-memory', route.path);
  assert.equal(Number.isFinite(payload.consecutiveFailures), true, route.path);
}

if (originalFetch) {
  globalThis.fetch = originalFetch;
}

console.log('registration harness ok');
