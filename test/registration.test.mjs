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
assert(regs.commands.includes('crag_session_search'), 'crag_session_search command present');
assert(regs.commands.includes('crag_session_describe'), 'crag_session_describe command present');
assert(regs.commands.includes('crag_session_expand'), 'crag_session_expand command present');
assert(regs.commands.includes('crag_session_quote'), 'crag_session_quote command present');
assert(regs.commands.includes('crag_session_export'), 'crag_session_export command present');
assert(regs.commands.includes('crag_corpus_ingest'), 'crag_corpus_ingest command present');
assert(regs.commands.includes('crag_corpus_search'), 'crag_corpus_search command present');
assert(regs.commands.includes('crag_corpus_describe'), 'crag_corpus_describe command present');
assert(regs.commands.includes('crag_large_describe'), 'crag_large_describe command present');
assert(regs.commands.includes('crag_large_search'), 'crag_large_search command present');
assert(regs.commands.includes('crag_large_excerpt'), 'crag_large_excerpt command present');
assert(regs.commands.includes('crag_explain_memory'), 'crag_explain_memory command present');
assert(!regs.routes.find(r => r.includes('crag-smoke')), 'no crag-smoke route');
console.log('registration tests passed');
