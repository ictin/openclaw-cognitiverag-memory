import {
  deriveNormalizedMemoryClassMix,
  derivePolicyRetrievalMode,
  deriveSourceClasses,
  type ContractValidation,
} from '../validators/contractValidator.js';

export function buildBackendSelectorPrompt(explanation: ContractValidation): string {
  if (!explanation.ok) {
    return `Backend selector explanation unavailable (fail-open): ${explanation.error}`;
  }
  const ex = explanation.value;
  const laneEntries = Object.entries(ex.lane_totals || {}).sort((a, b) => b[1] - a[1]);
  const sourceClasses = deriveSourceClasses(explanation);
  const retrievalMode = derivePolicyRetrievalMode(explanation);
  const classMix = deriveNormalizedMemoryClassMix(explanation);
  const lines = [
    'Backend selector explanation (authoritative):',
    `- intent_family: ${ex.intent_family}`,
    `- policy retrieval mode: ${retrievalMode.mode} (source=${retrievalMode.source})`,
    `- total_budget: ${ex.total_budget}`,
    `- reserved_tokens: ${ex.reserved_tokens}`,
    `- reorder_strategy: ${ex.reorder_strategy}`,
    `- selected_blocks: ${Array.isArray(ex.selected_blocks) ? ex.selected_blocks.length : 0}`,
    `- dropped_blocks: ${Array.isArray(ex.dropped_blocks) ? ex.dropped_blocks.length : 0}`,
    `- source classes: ${sourceClasses.length ? sourceClasses.join(', ') : 'none'}`,
    '- normalized memory class mix:',
    ...(classMix.length
      ? classMix.map(
          (entry) =>
            `  - ${entry.layerId}: selected=${entry.selectedBlockCount}, lane_tokens=${entry.laneTokens}, lanes=${entry.observedLanes.join('|') || 'none'}`,
        )
      : ['  - none']),
    '- lane totals:',
    ...(laneEntries.length ? laneEntries.slice(0, 8).map(([lane, tokens]) => `  - ${lane}: ${tokens}`) : ['  - none']),
  ];
  return lines.join('\n');
}
