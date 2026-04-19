import assert from 'node:assert/strict';
import { buildBackendSelectorPrompt } from '../src/engine/assemble.js';
import { validateSelectionExplanation } from '../src/validators/contractValidator.js';

const explanation = validateSelectionExplanation({
  intent_family: 'corpus_overview',
  retrieval_mode: 'full_memory',
  total_budget: 2048,
  reserved_tokens: 320,
  selected_blocks: [
    { id: 'c1', lane: 'corpus', memory_type: 'corpus_chunk', tokens: 120, utility: 0.9 },
    { id: 'l1', lane: 'large_file', memory_type: 'large_file_excerpt', tokens: 90, utility: 0.82 },
    { id: 'w1', lane: 'web', memory_type: 'web_evidence', tokens: 110, utility: 0.93 },
    { id: 'w2', lane: 'web', memory_type: 'web_promoted_fact', tokens: 60, utility: 0.88 },
  ],
  dropped_blocks: [],
  lane_totals: { corpus: 120, large_file: 90, web: 170 },
  cluster_coverage: [],
  reorder_strategy: 'front_back_anchor',
});

assert.equal(explanation.ok, true, 'selection explanation should validate');
const text = buildBackendSelectorPrompt(explanation);
assert.match(text, /source classes:\s*corpus, large-file, web evidence, web promoted/i);
assert.match(text, /policy retrieval mode:\s*full_memory \(source=backend\)/i);
assert.match(text, /normalized memory class mix:/i);
assert.match(
  text,
  /web class split:\s*web_evidence=selected=1,lane_tokens=170,\s*web_promoted=selected=1,lane_tokens=170,\s*collapsed_web_bucket=no/i,
);
assert.match(text, /web storage\/readback distinction:/i);
assert.match(
  text,
  /web_evidence:\s*storage_class=staged_external_evidence,\s*readback_blocks=1,\s*ids=w1,\s*types=web_evidence,\s*provenance_blocks=0/i,
);
assert.match(
  text,
  /web_promoted:\s*storage_class=promoted_reusable_web_knowledge,\s*readback_blocks=1,\s*ids=w2,\s*types=web_promoted_fact,\s*provenance_blocks=0/i,
);
assert.match(text, /collapsed_web_bucket=no/i);
assert.match(text, /corpus_memory:\s*selected=1,\s*lane_tokens=120/i);
assert.match(text, /large_file_memory:\s*selected=1,\s*lane_tokens=90/i);
assert.match(text, /web_evidence_memory:\s*selected=1,\s*lane_tokens=170/i);
assert.match(text, /web_promoted_memory:\s*selected=1,\s*lane_tokens=170/i);

console.log('plugin web source class rendering test passed');
