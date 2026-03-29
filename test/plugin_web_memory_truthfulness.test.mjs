import assert from 'node:assert/strict';
import { buildCragExplainMemoryText } from '../src/commands/cragExplainMemory.js';
import { validateSelectionExplanation } from '../src/validators/contractValidator.js';

const explanation = validateSelectionExplanation({
  intent_family: 'architecture_explanation',
  total_budget: 512,
  reserved_tokens: 128,
  selected_blocks: [
    { id: 'w1', lane: 'web', memory_type: 'web_evidence', tokens: 70, utility: 0.7 },
    { id: 'w2', lane: 'web', memory_type: 'web_promoted_fact', tokens: 50, utility: 0.6 },
    { id: 'c1', lane: 'corpus', memory_type: 'corpus_chunk', tokens: 44, utility: 0.5 },
  ],
  dropped_blocks: [],
  lane_totals: { web: 120, corpus: 44 },
  cluster_coverage: ['memory'],
  reorder_strategy: 'front_back_anchor',
});

const text = buildCragExplainMemoryText({
  slot: 'cognitiverag-memory',
  fallbackMirrorActive: true,
  explanation,
  onlineLaneStatus: 'enabled',
});

assert.match(text, /online lane status:\s*enabled/i);
assert.match(text, /backend-derived source classes:\s*corpus, web evidence, web promoted/i);
assert.match(text, /web_evidence:\s*backend-cached raw web evidence/i);
assert.match(text, /web_promoted_fact:\s*backend-promoted reusable web-backed fact/i);
assert.match(text, /mirrors are supporting\/export layers, not canonical intelligence/i);

console.log('plugin web memory truthfulness test passed');
