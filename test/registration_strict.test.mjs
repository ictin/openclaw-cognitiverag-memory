import assert from 'assert';
import register from '../index.js';
let regs = { commands: [], routes: [], contextEngines: {} };
const api = {
  registerCommand: (c) => regs.commands.push(c.name),
  registerHttpRoute: (r) => regs.routes.push(r.path),
  registerContextEngine: (id, f) => { regs.contextEngines[id] = f(); },
  config: { plugins: { slots: { contextEngine: 'test' } } },
};
register(api);
// Enforce exact registration counts and names
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/status').length, 1, 'exactly one status route');
assert.strictEqual(regs.routes.filter(r => r === '/cognitiverag-memory/health').length, 1, 'exactly one health route');
assert.ok(regs.commands.includes('crag_status'), 'crag_status present');
assert.ok(!regs.commands.includes('crag-status'), 'crag-status absent');
console.log('registration strict test passed');
