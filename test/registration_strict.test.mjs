import assert from 'assert';
import register from '../index.js';
let regs = { commands: [], routes: [], contextEngines: {} };
let spy = {
  createdSessions: [],
  wroteTranscripts: [],
  syntheticCreates: 0,
};
// Extended fake API that includes session/transcript methods the plugin must NOT call during registration
const api = {
  registerCommand: (c) => regs.commands.push(c.name),
  registerHttpRoute: (r) => regs.routes.push(r.path),
  registerContextEngine: (id, f) => { regs.contextEngines[id] = f(); },
  // session/transcript shims that increment spies if invoked
  createSession: (s) => { spy.syntheticCreates += 1; spy.createdSessions.push(s); throw new Error('createSession should not be called during registration'); },
  writeTranscript: (t) => { spy.wroteTranscripts.push(t); throw new Error('writeTranscript should not be called during registration'); },
  // config slot
  config: { plugins: { slots: { contextEngine: 'test' } } },
};
// Run registration and ensure no session/transcript writes happen
let didThrow = false;
try {
  register(api);
} catch (e) {
  didThrow = true;
  // If plugin tried to call createSession/writeTranscript during register, the fake API throws — fail the test with clear message
  assert.fail('Plugin invoked session/transcript creation during registration: ' + String(e?.message ?? e));
}
// Enforce exact registration counts and names
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/status').length, 1, 'exactly one status route');
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/health').length, 1, 'exactly one health route');
assert.ok(regs.commands.includes('crag_status'), 'crag_status present');
assert.ok(regs.commands.includes('crag_recall'), 'crag_recall present');
assert.ok(regs.commands.includes('crag_session_search'), 'crag_session_search present');
assert.ok(regs.commands.includes('crag_session_describe'), 'crag_session_describe present');
assert.ok(regs.commands.includes('crag_session_expand'), 'crag_session_expand present');
assert.ok(regs.commands.includes('crag_session_quote'), 'crag_session_quote present');
assert.ok(regs.commands.includes('crag_session_export'), 'crag_session_export present');
assert.ok(regs.commands.includes('crag_corpus_ingest'), 'crag_corpus_ingest present');
assert.ok(regs.commands.includes('crag_corpus_search'), 'crag_corpus_search present');
assert.ok(regs.commands.includes('crag_corpus_describe'), 'crag_corpus_describe present');
assert.ok(regs.commands.includes('crag_large_describe'), 'crag_large_describe present');
assert.ok(regs.commands.includes('crag_large_search'), 'crag_large_search present');
assert.ok(regs.commands.includes('crag_large_excerpt'), 'crag_large_excerpt present');
assert.ok(regs.commands.includes('crag_explain_memory'), 'crag_explain_memory present');
assert.ok(!regs.commands.includes('crag-status'), 'crag-status absent');
// Ensure the fake session/transcript methods were never called
assert.strictEqual(spy.syntheticCreates, 0, 'no synthetic session creates during registration');
assert.strictEqual(spy.wroteTranscripts.length, 0, 'no transcript writes during registration');
console.log('registration strict test passed');
