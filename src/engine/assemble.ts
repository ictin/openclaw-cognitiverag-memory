import {
  deriveNormalizedMemoryClassMix,
  derivePolicyRetrievalMode,
  deriveSourceClasses,
  deriveWebClassReadbackSummary,
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
  const webReadback = deriveWebClassReadbackSummary(explanation);
  const webEvidence = classMix.find((entry) => entry.layerId === 'web_evidence_memory');
  const webPromoted = classMix.find((entry) => entry.layerId === 'web_promoted_memory');
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
    `- web class split: web_evidence=${webEvidence ? `selected=${webEvidence.selectedBlockCount},lane_tokens=${webEvidence.laneTokens}` : 'selected=0,lane_tokens=0'}, web_promoted=${webPromoted ? `selected=${webPromoted.selectedBlockCount},lane_tokens=${webPromoted.laneTokens}` : 'selected=0,lane_tokens=0'}, collapsed_web_bucket=no`,
    '- web storage/readback distinction:',
    `  - web_evidence: storage_class=${webReadback?.webEvidence.storageClass ?? 'unknown'}, readback_blocks=${webReadback?.webEvidence.readbackBlockCount ?? 0}, ids=${webReadback?.webEvidence.selectedBlockIds.join('|') || 'none'}, types=${webReadback?.webEvidence.observedMemoryTypes.join('|') || 'none'}, provenance_blocks=${webReadback?.webEvidence.provenanceBackedCount ?? 0}`,
    `  - web_promoted: storage_class=${webReadback?.webPromoted.storageClass ?? 'unknown'}, readback_blocks=${webReadback?.webPromoted.readbackBlockCount ?? 0}, ids=${webReadback?.webPromoted.selectedBlockIds.join('|') || 'none'}, types=${webReadback?.webPromoted.observedMemoryTypes.join('|') || 'none'}, provenance_blocks=${webReadback?.webPromoted.provenanceBackedCount ?? 0}`,
    `  - collapsed_web_bucket=${webReadback?.collapsedWebBucket === false ? 'no' : 'unknown'}`,
    '- lane totals:',
    ...(laneEntries.length ? laneEntries.slice(0, 8).map(([lane, tokens]) => `  - ${lane}: ${tokens}`) : ['  - none']),
  ];
  return lines.join('\n');
}
