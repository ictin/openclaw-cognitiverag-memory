import assert from 'assert';
import register from '../index.js';

let regs = { commands: [], routes: [], contextEngines: {}, handlers: {} };
let spy = {
  createdSessions: [],
  wroteTranscripts: [],
  syntheticCreates: 0,
};

// Fake req/res helpers
function makeReq() {
  return { method: 'GET', url: '/', headers: {} };
}

function makeRes() {
  let res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(d) { this.body += String(d ?? ''); },
  };
  return res;
}

const api = {
  registerCommand: (c) => regs.commands.push(c.name),
  registerHttpRoute: (r) => { regs.routes.push(r.path); if(r.path) regs.handlers[r.path] = r.handler; },
  registerContextEngine: (id, f) => { regs.contextEngines[id] = f(); },
  // session/transcript shims that increment spies if invoked
  createSession: (s) => { spy.syntheticCreates += 1; spy.createdSessions.push(s); throw new Error('createSession should not be called during handlers'); },
  writeTranscript: (t) => { spy.wroteTranscripts.push(t); throw new Error('writeTranscript should not be called during handlers'); },
  config: { plugins: { slots: { contextEngine: 'test' } } },
};

register(api);

// Ensure routes registered as expected
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/status').length, 1, 'exactly one status route');
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/health').length, 1, 'exactly one health route');

// Grab handlers
const statusHandler = regs.handlers['/cognitiverag-memory/status'];
const healthHandler = regs.handlers['/cognitiverag-memory/health'];
assert.strictEqual(typeof statusHandler, 'function', 'status handler present');
assert.strictEqual(typeof healthHandler, 'function', 'health handler present');

// Invoke both handlers and assert JSON-like responses and no synthetic writes
(async () => {
  const req1 = makeReq();
  const res1 = makeRes();
  const ok1 = await statusHandler(req1, res1);
  assert.ok(ok1 === true, 'status handler should return true');
  // parse response body as JSON
  let parsed1 = null;
  try { parsed1 = JSON.parse(res1.body); } catch (e) { assert.fail('status handler did not respond with valid JSON'); }
  assert.ok(parsed1 && typeof parsed1 === 'object', 'status handler returned object');

  const req2 = makeReq();
  const res2 = makeRes();
  const ok2 = await healthHandler(req2, res2);
  assert.ok(ok2 === true, 'health handler should return true');
  let parsed2 = null;
  try { parsed2 = JSON.parse(res2.body); } catch (e) { assert.fail('health handler did not respond with valid JSON'); }
  assert.ok(parsed2 && typeof parsed2 === 'object', 'health handler returned object');

  // Ensure no synthetic sessions or transcript writes occurred during handler calls
  assert.strictEqual(spy.syntheticCreates, 0, 'no synthetic session creates during handlers');
  assert.strictEqual(spy.wroteTranscripts.length, 0, 'no transcript writes during handlers');

  console.log('health handlers read-only test passed');
})();
