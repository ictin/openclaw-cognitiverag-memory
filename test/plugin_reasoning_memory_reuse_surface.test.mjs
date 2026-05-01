import assert from 'node:assert/strict';
import { buildBackendSelectorPrompt } from '../src/engine/assemble.js';
import { buildCragExplainMemoryText } from '../src/commands/cragExplainMemory.js';
import { validateSelectionExplanation } from '../src/validators/contractValidator.js';

const explanation = validateSelectionExplanation({
  intent_family: 'explain_support',
  retrieval_mode: 'task_memory',
  total_budget: 512,
  reserved_tokens: 128,
  selected_blocks: [
    {
      id: 'r1',
      lane: 'reasoning',
      memory_type: 'reasoning_record',
      tokens: 70,
      utility: 0.88,
      provenance: { source_class: 'reasoning', reasoning_case_id: 'rc_001' },
    },
    {
      id: 'p1',
      lane: 'promoted',
      memory_type: 'promoted_fact',
      tokens: 62,
      utility: 0.79,
      provenance: { source_class: 'promoted', promoted_item_id: 'pm_001' },
    },
  ],
  dropped_blocks: [],
  lane_totals: { reasoning: 70, promoted: 62 },
  cluster_coverage: ['support'],
  reorder_strategy: 'front_back_anchor',
});

assert.equal(explanation.ok, true, 'selection explanation should validate');
const selectorText = buildBackendSelectorPrompt(explanation);
assert.match(selectorText, /reasoning-memory reuse distinction:/i);
assert.match(
  selectorText,
  /reasoning_reuse:\s*visible=yes,\s*ids=r1,\s*types=reasoning_record,\s*provenance_blocks=1/i,
);
assert.match(
  selectorText,
  /generic_promoted:\s*ids=p1,\s*types=promoted_fact,\s*provenance_blocks=1/i,
);
assert.match(selectorText, /collapsed_into_generic_promoted=no/i);

const explainText = buildCragExplainMemoryText({
  slot: 'cognitiverag-memory',
  fallbackMirrorActive: false,
  explanation,
  onlineLaneStatus: 'unknown',
});
assert.match(explainText, /reasoning-memory reuse distinction:/i);
assert.match(
  explainText,
  /reasoning_reuse:\s*visible=yes,\s*ids=r1,\s*types=reasoning_record,\s*provenance_blocks=1/i,
);
assert.match(
  explainText,
  /generic_promoted:\s*ids=p1,\s*types=promoted_fact,\s*provenance_blocks=1/i,
);
assert.match(explainText, /collapsed_into_generic_promoted=no/i);

console.log('plugin reasoning memory reuse surface test passed');
