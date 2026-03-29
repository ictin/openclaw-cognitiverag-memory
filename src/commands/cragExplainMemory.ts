import type { ContractValidation } from '../validators/contractValidator.js';

export function buildCragExplainMemoryText(args: {
  slot: string;
  fallbackMirrorActive: boolean;
  explanation: ContractValidation;
}): string {
  const lines: string[] = [
    'CognitiveRAG Memory Architecture',
    `- active context engine slot: ${args.slot}`,
    '- cognitiverag-memory plugin loaded: yes',
    '- backend/session memory: primary CRAG context layer',
    '- local lossless session layer: raw + compacted session memory for recall/quote/expand',
    '- corpus layer: chunked document retrieval with provenance',
    '- large-file layer: bounded excerpt retrieval with locators',
    `- fallback mirror MEMORY.md active: ${args.fallbackMirrorActive ? 'yes' : 'no'}`,
    '- mirrors are supporting/export layers, not canonical intelligence',
  ];

  if (args.explanation.ok) {
    const ex = args.explanation.value;
    lines.push('- backend selector explanation: valid');
    lines.push(`- selector intent family: ${ex.intent_family}`);
    lines.push(`- selector budget: total=${ex.total_budget}, reserved=${ex.reserved_tokens}`);
    const laneEntries = Object.entries(ex.lane_totals || {}).sort((a, b) => b[1] - a[1]);
    if (laneEntries.length) {
      lines.push('- selector lane totals (tokens):');
      for (const [lane, tokens] of laneEntries.slice(0, 8)) lines.push(`  - ${lane}: ${tokens}`);
    } else {
      lines.push('- selector lane totals: none');
    }
    lines.push(`- selector reorder strategy: ${ex.reorder_strategy}`);
  } else {
    lines.push('- backend selector explanation: unavailable (fail-open)');
    lines.push(`- explanation validation error: ${args.explanation.error}`);
  }

  lines.push('- source truth:');
  lines.push('  - backend_session_memory: CRAG backend/session context');
  lines.push('  - lossless_session_raw: plugin-local exact message storage');
  lines.push('  - lossless_session_compact: plugin-local compacted history summaries');
  lines.push('  - large_file_excerpt: plugin-local large-file excerpt with locator');
  lines.push('  - corpus_chunk: plugin-local corpus chunk with provenance');
  lines.push('  - fallback_mirror_plugin/workspace: markdown mirror fallback');

  return lines.join('\n');
}

