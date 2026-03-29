import assert from 'node:assert/strict';
import {
  validateSelectionExplanation,
  deriveSourceClasses,
  deriveOnlineLaneStatus,
} from '../src/validators/contractValidator.js';

const valid = validateSelectionExplanation({
  intent_family: 'investigative',
  total_budget: 1024,
  reserved_tokens: 200,
  selected_blocks: [
    { id: 'x1', lane: 'web', memory_type: 'web_evidence', tokens: 55, utility: 0.9 },
    { id: 'x2', lane: 'web', memory_type: 'web_promoted_fact', tokens: 33, utility: 0.7 },
    { id: 'x3', lane: 'large_file', memory_type: 'large_file_excerpt', tokens: 40, utility: 0.6 },
    { id: 'x4', lane: 'corpus', memory_type: 'corpus_chunk', tokens: 42, utility: 0.6 },
  ],
  dropped_blocks: [],
  lane_totals: { web: 88, corpus: 42, large_file: 40 },
  cluster_coverage: [],
  reorder_strategy: 'front_back_anchor',
});

assert.equal(valid.ok, true, 'valid backend explanation should pass');
assert.deepEqual(deriveSourceClasses(valid), ['corpus', 'large-file', 'web evidence', 'web promoted']);
assert.equal(deriveOnlineLaneStatus(valid), 'enabled');

const nonWeb = validateSelectionExplanation({
  intent_family: 'memory_summary',
  total_budget: 512,
  reserved_tokens: 128,
  selected_blocks: [{ id: 'm1', lane: 'episodic', memory_type: 'episodic_raw', tokens: 70, utility: 0.8 }],
  dropped_blocks: [],
  lane_totals: { episodic: 70 },
  cluster_coverage: [],
  reorder_strategy: 'front_back_anchor',
});
assert.equal(nonWeb.ok, true);
assert.equal(deriveOnlineLaneStatus(nonWeb), 'disabled');

const invalid = validateSelectionExplanation('bad-shape');
assert.equal(invalid.ok, false);
assert.equal(deriveOnlineLaneStatus(invalid), 'unknown');
assert.deepEqual(deriveSourceClasses(invalid), []);

console.log('plugin backend web contract validation test passed');
