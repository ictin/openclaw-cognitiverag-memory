import assert from "assert";
import register from "../index.js";
let regs = { commands: [], routes: [], contextEngines: {} };
const api = {
  registerCommand: (c) => regs.commands.push(c.name),
  registerHttpRoute: (r) => regs.routes.push(r.path),
  registerContextEngine: (id, f) => { regs.contextEngines[id] = f(); },
  config: { plugins: { slots: { contextEngine: 'test' } } },
};
register(api);
assert(regs.routes.filter(r => r === '/cognitiverag-memory/status').length === 1, 'status route count');
assert(regs.routes.filter(r => r === '/cognitiverag-memory/health').length === 1, 'health route count');
assert(regs.commands.includes('crag_status'), 'crag_status command present');
assert(regs.commands.includes('crag_recall'), 'crag_recall command present');
assert(regs.commands.includes('crag_explain_memory'), 'crag_explain_memory command present');
assert(!regs.routes.find(r => r.includes('crag-smoke')), 'no crag-smoke route');
console.log('registration tests passed');
