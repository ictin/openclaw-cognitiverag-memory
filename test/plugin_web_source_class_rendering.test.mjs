import assert from 'node:assert/strict';
import { buildBackendSelectorPrompt } from '../src/engine/assemble.js';
import { validateSelectionExplanation } from '../src/validators/contractValidator.js';

const explanation = validateSelectionExplanation({
  intent_family: 'corpus_overview',
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

console.log('plugin web source class rendering test passed');
