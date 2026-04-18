export type CanonicalMemoryLayer = {
  layerId:
    | 'working_memory'
    | 'episodic_memory'
    | 'semantic_memory'
    | 'procedural_memory'
    | 'task_memory'
    | 'profile_memory'
    | 'reasoning_memory'
    | 'corpus_memory'
    | 'large_file_memory'
    | 'web_evidence_memory'
    | 'web_promoted_memory'
    | 'mirror_memory';
  displayName: string;
  runtimeRole: string;
};

// Canonical F-001 taxonomy registry aligned to the frozen master specification.
export const CANONICAL_12_LAYER_MEMORY_TAXONOMY: readonly CanonicalMemoryLayer[] = Object.freeze([
  {
    layerId: 'working_memory',
    displayName: 'Working memory',
    runtimeRole: 'transient bounded assembly for current turn context',
  },
  {
    layerId: 'episodic_memory',
    displayName: 'Episodic memory',
    runtimeRole: 'what happened in sessions/turn trajectories',
  },
  {
    layerId: 'semantic_memory',
    displayName: 'Semantic memory',
    runtimeRole: 'durable reusable truths and promoted facts',
  },
  {
    layerId: 'procedural_memory',
    displayName: 'Procedural memory',
    runtimeRole: 'reusable workflows and know-how',
  },
  {
    layerId: 'task_memory',
    displayName: 'Task memory',
    runtimeRole: 'active objective, blockers, next steps, acceptance state',
  },
  {
    layerId: 'profile_memory',
    displayName: 'Profile memory',
    runtimeRole: 'stable preferences and constraints',
  },
  {
    layerId: 'reasoning_memory',
    displayName: 'Reasoning memory',
    runtimeRole: 'reasoning traces and support decisions',
  },
  {
    layerId: 'corpus_memory',
    displayName: 'Corpus memory',
    runtimeRole: 'chunked local document retrieval with provenance',
  },
  {
    layerId: 'large_file_memory',
    displayName: 'Large-file memory',
    runtimeRole: 'bounded excerpt retrieval for oversized sources',
  },
  {
    layerId: 'web_evidence_memory',
    displayName: 'Web evidence memory',
    runtimeRole: 'freshness-sensitive staged web captures',
  },
  {
    layerId: 'web_promoted_memory',
    displayName: 'Web promoted memory',
    runtimeRole: 'durable promoted web-backed knowledge',
  },
  {
    layerId: 'mirror_memory',
    displayName: 'Mirror memory',
    runtimeRole: 'human/export/debug mirrors; never canonical intelligence',
  },
]);

export function renderTaxonomyRegistryHeader(): string {
  return `- canonical taxonomy registry: ${CANONICAL_12_LAYER_MEMORY_TAXONOMY.length} layers (F-001 canonical model)`;
}

export function renderCanonicalTaxonomyRegistryLines(): string[] {
  const lines: string[] = ['- canonical 12-layer memory taxonomy registry:'];
  for (const layer of CANONICAL_12_LAYER_MEMORY_TAXONOMY) {
    lines.push(`  - ${layer.displayName} [${layer.layerId}]: ${layer.runtimeRole}`);
  }
  return lines;
}

