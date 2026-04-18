import assert from 'node:assert/strict';
import { buildCragExplainMemoryText } from '../src/commands/cragExplainMemory.js';
import { validateSelectionExplanation } from '../src/validators/contractValidator.js';

const explanation = validateSelectionExplanation({
  intent_family: 'architecture_explanation',
  retrieval_mode: 'full_memory',
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
  discoveryPlan: { risk_mode: 'medium', expected_sources: ['web', 'corpus'] },
  discovery: { top_discoveries: [{ id: 'd1' }, { id: 'd2' }] },
});

assert.match(text, /online lane status:\s*enabled/i);
assert.match(text, /backend-derived source classes:\s*corpus, web evidence, web promoted/i);
assert.match(text, /policy retrieval mode:\s*full_memory \(source=backend\)/i);
assert.match(text, /normalized retrieval memory-class metadata:/i);
assert.match(
  text,
  /web class split:\s*web_evidence=selected=1,lane_tokens=120,\s*web_promoted=selected=1,lane_tokens=120,\s*collapsed_web_bucket=no/i,
);
assert.match(text, /corpus_memory:\s*selected=1,\s*lane_tokens=44/i);
assert.match(text, /web_evidence_memory:\s*selected=1,\s*lane_tokens=120/i);
assert.match(text, /web_promoted_memory:\s*selected=1,\s*lane_tokens=120/i);
assert.match(text, /backend ownership:\s*canonical memory\/retrieval\/discovery intelligence/i);
assert.match(text, /web evidence:\s*backend-cached raw web evidence/i);
assert.match(text, /web promoted:\s*backend-promoted reusable web-backed facts/i);
assert.match(text, /mirrors are supporting\/export\/debug layers, not canonical intelligence/i);
assert.match(text, /compaction truth:\s*compacted local\/session slices keep lineage and remain recoverable/i);
assert.match(text, /staged\/trusted\/stale\/contradictory/i);
assert.match(text, /backend discovery plan surfaced:\s*yes/i);
assert.match(text, /bounded discovery items:\s*2/i);

console.log('plugin web memory truthfulness test passed');
