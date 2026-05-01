import {
  deriveNormalizedMemoryClassMix,
  derivePolicyRetrievalMode,
  deriveReasoningReuseSummary,
  deriveSourceClasses,
  deriveWebClassReadbackSummary,
  type ContractValidation,
  type OnlineLaneStatus,
} from '../validators/contractValidator.js';
import { renderCanonicalTaxonomyRegistryLines, renderTaxonomyRegistryHeader } from '../contracts/memoryTaxonomy.js';

export function buildCragExplainMemoryText(args: {
  slot: string;
  fallbackMirrorActive: boolean;
  explanation: ContractValidation;
  onlineLaneStatus?: OnlineLaneStatus;
  runtimeEntryPath?: string;
  runtimePluginRoot?: string;
  discoveryPlan?: unknown;
  discovery?: unknown;
}): string {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const sourceClasses = deriveSourceClasses(args.explanation);
  const retrievalMode = derivePolicyRetrievalMode(args.explanation);
  const classMix = deriveNormalizedMemoryClassMix(args.explanation);
  const reasoningReuse = deriveReasoningReuseSummary(args.explanation);
  const webReadback = deriveWebClassReadbackSummary(args.explanation);
  const lines: string[] = [
    'CognitiveRAG Memory Architecture',
    `- active context engine slot: ${args.slot}`,
    '- cognitiverag-memory plugin loaded: yes',
    `- runtime entry path: ${args.runtimeEntryPath ?? 'unknown'}`,
    `- runtime plugin root: ${args.runtimePluginRoot ?? 'unknown'}`,
    '- backend ownership: canonical memory/retrieval/discovery intelligence',
    renderTaxonomyRegistryHeader(),
    `- online lane status: ${args.onlineLaneStatus ?? 'unknown'}`,
    '- backend/session memory: primary CRAG context layer',
    '- backend promoted memory: durable normalized reusable memory',
    '- backend skill memory: typed principles/templates/examples/rubrics/anti-patterns/workflows',
    '- backend execution memory: stored skill-run execution cases linked to artifact usage',
    '- backend evaluation memory: rubric-scored quality cases linked to execution runs',
    '- local lossless session layer: raw + compacted session memory for recall/quote/expand',
    '- compaction truth: compacted local/session slices keep lineage and remain recoverable',
    '- corpus layer: chunked document retrieval with provenance',
    '- large-file layer: bounded excerpt retrieval with locators',
    `- fallback mirror MEMORY.md active: ${args.fallbackMirrorActive ? 'yes' : 'no'}`,
    '- mirrors are supporting/export/debug layers, not canonical intelligence',
    ...renderCanonicalTaxonomyRegistryLines(),
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
    lines.push(
      `- backend-derived source classes: ${sourceClasses.length ? sourceClasses.join(', ') : 'none surfaced in this probe'}`,
    );
    lines.push(`- policy retrieval mode: ${retrievalMode.mode} (source=${retrievalMode.source})`);
    lines.push('- normalized retrieval memory-class metadata:');
    const webEvidence = classMix.find((entry) => entry.layerId === 'web_evidence_memory');
    const webPromoted = classMix.find((entry) => entry.layerId === 'web_promoted_memory');
    lines.push(
      `- web class split: web_evidence=${webEvidence ? `selected=${webEvidence.selectedBlockCount},lane_tokens=${webEvidence.laneTokens}` : 'selected=0,lane_tokens=0'}, web_promoted=${webPromoted ? `selected=${webPromoted.selectedBlockCount},lane_tokens=${webPromoted.laneTokens}` : 'selected=0,lane_tokens=0'}, collapsed_web_bucket=no`,
    );
    lines.push('- reasoning-memory reuse distinction:');
    lines.push(
      `  - reasoning_reuse: visible=${reasoningReuse?.reasoningReuseVisible ? 'yes' : 'no'}, ids=${reasoningReuse?.reasoningReuseBlockIds.join('|') || 'none'}, types=${reasoningReuse?.reasoningReuseMemoryTypes.join('|') || 'none'}, provenance_blocks=${reasoningReuse?.reasoningProvenanceCount ?? 0}`,
    );
    lines.push(
      `  - generic_promoted: ids=${reasoningReuse?.genericPromotedBlockIds.join('|') || 'none'}, types=${reasoningReuse?.genericPromotedMemoryTypes.join('|') || 'none'}, provenance_blocks=${reasoningReuse?.genericPromotedProvenanceCount ?? 0}`,
    );
    lines.push(
      `  - collapsed_into_generic_promoted=${reasoningReuse?.collapsedIntoGenericPromoted === false ? 'no' : 'unknown'}`,
    );
    lines.push('- web storage/readback distinction:');
    lines.push(
      `  - web_evidence: storage_class=${webReadback?.webEvidence.storageClass ?? 'unknown'}, readback_blocks=${webReadback?.webEvidence.readbackBlockCount ?? 0}, ids=${webReadback?.webEvidence.selectedBlockIds.join('|') || 'none'}, types=${webReadback?.webEvidence.observedMemoryTypes.join('|') || 'none'}, provenance_blocks=${webReadback?.webEvidence.provenanceBackedCount ?? 0}`,
    );
    lines.push(
      `  - web_promoted: storage_class=${webReadback?.webPromoted.storageClass ?? 'unknown'}, readback_blocks=${webReadback?.webPromoted.readbackBlockCount ?? 0}, ids=${webReadback?.webPromoted.selectedBlockIds.join('|') || 'none'}, types=${webReadback?.webPromoted.observedMemoryTypes.join('|') || 'none'}, provenance_blocks=${webReadback?.webPromoted.provenanceBackedCount ?? 0}`,
    );
    lines.push(`  - collapsed_web_bucket=${webReadback?.collapsedWebBucket === false ? 'no' : 'unknown'}`);
    if (classMix.length) {
      for (const entry of classMix) {
        lines.push(
          `  - ${entry.layerId}: selected=${entry.selectedBlockCount}, lane_tokens=${entry.laneTokens}, lanes=${entry.observedLanes.join('|') || 'none'}, types=${entry.observedMemoryTypes.join('|') || 'none'}`,
        );
      }
    } else {
      lines.push('  - none');
    }
    lines.push(`- selector reorder strategy: ${ex.reorder_strategy}`);
  } else {
    lines.push('- backend selector explanation: unavailable (fail-open)');
    lines.push(`- explanation validation error: ${args.explanation.error}`);
    lines.push('- backend-derived source classes: unavailable');
    lines.push('- policy retrieval mode: unknown (source=unknown)');
    lines.push('- normalized retrieval memory-class metadata: unavailable');
    lines.push('- web class split: unavailable');
    lines.push('- reasoning-memory reuse distinction: unavailable');
    lines.push('- web storage/readback distinction: unavailable');
  }

  const discoveryPlan = isRecord(args.discoveryPlan) ? args.discoveryPlan : null;
  const discovery = isRecord(args.discovery) ? args.discovery : null;
  lines.push(`- backend discovery plan surfaced: ${discoveryPlan ? 'yes' : 'no'}`);
  if (discoveryPlan) {
    const riskMode = String(discoveryPlan.risk_mode ?? discoveryPlan.riskMode ?? 'unknown');
    const expectedSources = Array.isArray(discoveryPlan.expected_sources)
      ? discoveryPlan.expected_sources.map((entry) => String(entry)).filter(Boolean)
      : [];
    lines.push(`  - discovery risk mode: ${riskMode}`);
    lines.push(`  - discovery expected sources: ${expectedSources.length ? expectedSources.join(', ') : 'none'}`);
  }
  lines.push(`- backend discovery findings surfaced: ${discovery ? 'yes' : 'no'}`);
  if (discovery) {
    const topDiscoveries = Array.isArray(discovery.top_discoveries)
      ? discovery.top_discoveries
      : Array.isArray(discovery.topDiscoveries)
        ? discovery.topDiscoveries
        : [];
    lines.push(`  - bounded discovery items: ${topDiscoveries.length}`);
  }

  lines.push('- source truth:');
  lines.push('  - backend/session: primary CRAG conversation memory');
  lines.push('  - promoted: backend durable promoted memory');
  lines.push('  - skill memory: backend typed skill artifacts and task-aware packs');
  lines.push('  - execution memory: backend stored skill-run cases');
  lines.push('  - evaluation memory: backend rubric-based quality evaluations');
  lines.push('  - corpus: backend corpus retrieval with provenance');
  lines.push('  - large-file: backend bounded large-file excerpts');
  lines.push('  - web evidence: backend-cached raw web evidence (freshness-sensitive)');
  lines.push('  - web promoted: backend-promoted reusable web-backed facts');
  lines.push('  - promotion/freshness/conflict states (staged/trusted/stale/contradictory) stay backend-canonical');
  lines.push('  - mirrors (MEMORY.md + memory/*.md): support/export/debug surfaces only');

  return lines.join('\n');
}
