export type SelectedBlock = {
  id: string;
  lane: string;
  memory_type: string;
  tokens: number;
  utility: number;
  cluster_id?: string | null;
  provenance?: Record<string, unknown>;
};

export type DroppedBlock = {
  id: string;
  lane: string;
  tokens: number;
  reason: string;
};

export type SelectionExplanation = {
  intent_family: string;
  retrieval_mode?: string;
  total_budget: number;
  reserved_tokens: number;
  selected_blocks: SelectedBlock[];
  dropped_blocks: DroppedBlock[];
  lane_totals: Record<string, number>;
  cluster_coverage: string[];
  reorder_strategy: string;
};

export type ContractValidation =
  | { ok: true; value: SelectionExplanation }
  | { ok: false; error: string };

export type SourceClass = 'corpus' | 'large-file' | 'web evidence' | 'web promoted';
export type PolicyRetrievalMode = 'documents_only' | 'regression_test' | 'task_memory' | 'full_memory' | 'unknown';
export type PolicyModeSource = 'backend' | 'inferred' | 'unknown';
export type NormalizedMemoryLayerId =
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

export type NormalizedMemoryClassEntry = {
  layerId: NormalizedMemoryLayerId;
  selectedBlockCount: number;
  laneTokens: number;
  observedLanes: string[];
  observedMemoryTypes: string[];
};

export type WebClassReadbackEntry = {
  storageClass: 'staged_external_evidence' | 'promoted_reusable_web_knowledge';
  readbackBlockCount: number;
  selectedBlockIds: string[];
  observedMemoryTypes: string[];
  provenanceBackedCount: number;
};

export type WebClassReadbackSummary = {
  webEvidence: WebClassReadbackEntry;
  webPromoted: WebClassReadbackEntry;
  collapsedWebBucket: false;
};

export type ReasoningReuseSummary = {
  reasoningReuseVisible: boolean;
  reasoningReuseBlockIds: string[];
  reasoningReuseMemoryTypes: string[];
  reasoningProvenanceCount: number;
  genericPromotedBlockIds: string[];
  genericPromotedMemoryTypes: string[];
  genericPromotedProvenanceCount: number;
  collapsedIntoGenericPromoted: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateSelectionExplanation(input: unknown): ContractValidation {
  if (!isRecord(input)) return { ok: false, error: 'explanation_not_object' };

  const selectedBlocks = Array.isArray(input.selected_blocks) ? input.selected_blocks : [];
  const droppedBlocks = Array.isArray(input.dropped_blocks) ? input.dropped_blocks : [];
  const laneTotals = isRecord(input.lane_totals) ? input.lane_totals : null;
  const clusterCoverage = Array.isArray(input.cluster_coverage) ? input.cluster_coverage : [];

  if (typeof input.intent_family !== 'string' || !input.intent_family.trim()) {
    return { ok: false, error: 'missing_intent_family' };
  }
  if (!isFiniteNumber(input.total_budget) || !isFiniteNumber(input.reserved_tokens)) {
    return { ok: false, error: 'missing_budget_fields' };
  }
  if (!laneTotals) return { ok: false, error: 'missing_lane_totals' };

  for (const item of selectedBlocks) {
    if (!isRecord(item)) return { ok: false, error: 'invalid_selected_block' };
    if (typeof item.id !== 'string' || typeof item.lane !== 'string' || typeof item.memory_type !== 'string') {
      return { ok: false, error: 'invalid_selected_block_identity' };
    }
    if (!isFiniteNumber(item.tokens) || !isFiniteNumber(item.utility)) {
      return { ok: false, error: 'invalid_selected_block_scores' };
    }
  }

  for (const item of droppedBlocks) {
    if (!isRecord(item)) return { ok: false, error: 'invalid_dropped_block' };
    if (typeof item.id !== 'string' || typeof item.lane !== 'string' || typeof item.reason !== 'string') {
      return { ok: false, error: 'invalid_dropped_block_identity' };
    }
    if (!isFiniteNumber(item.tokens)) return { ok: false, error: 'invalid_dropped_block_tokens' };
  }

  const normalizedLaneTotals: Record<string, number> = {};
  for (const [lane, tokens] of Object.entries(laneTotals)) {
    if (!isFiniteNumber(tokens)) continue;
    normalizedLaneTotals[lane] = Math.max(0, Math.floor(tokens));
  }

  const value: SelectionExplanation = {
    intent_family: input.intent_family.trim(),
    retrieval_mode: typeof input.retrieval_mode === 'string' ? input.retrieval_mode.trim() : undefined,
    total_budget: Math.max(0, Math.floor(input.total_budget)),
    reserved_tokens: Math.max(0, Math.floor(input.reserved_tokens)),
    selected_blocks: selectedBlocks as SelectedBlock[],
    dropped_blocks: droppedBlocks as DroppedBlock[],
    lane_totals: normalizedLaneTotals,
    cluster_coverage: clusterCoverage.map((entry) => String(entry)).filter(Boolean),
    reorder_strategy: typeof input.reorder_strategy === 'string' ? input.reorder_strategy : 'front_back_anchor',
  };
  return { ok: true, value };
}

function normalizeMemoryType(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
}

function normalizeLane(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
}

export function deriveSourceClasses(explanation: ContractValidation): SourceClass[] {
  if (!explanation.ok) return [];
  const classes = new Set<SourceClass>();

  const addFrom = (memoryTypeRaw: unknown, laneRaw: unknown) => {
    const memoryType = normalizeMemoryType(memoryTypeRaw);
    const lane = normalizeLane(laneRaw);

    if (
      memoryType === 'web_evidence' ||
      memoryType === 'web_evidence_raw' ||
      memoryType.includes('web_evidence') ||
      lane === 'web'
    ) {
      classes.add('web evidence');
    }
    if (
      memoryType === 'web_promoted_fact' ||
      memoryType === 'web_promoted' ||
      memoryType.includes('web_promoted')
    ) {
      classes.add('web promoted');
    }
    if (memoryType === 'corpus_chunk' || memoryType.includes('corpus') || lane === 'corpus') {
      classes.add('corpus');
    }
    if (memoryType === 'large_file_excerpt' || memoryType.includes('large_file') || lane === 'large_file') {
      classes.add('large-file');
    }
  };

  for (const block of explanation.value.selected_blocks) {
    addFrom(block?.memory_type, block?.lane);
  }
  for (const [lane] of Object.entries(explanation.value.lane_totals || {})) {
    addFrom('', lane);
  }

  const ordered: SourceClass[] = ['corpus', 'large-file', 'web evidence', 'web promoted'];
  return ordered.filter((label) => classes.has(label));
}

export type OnlineLaneStatus = 'enabled' | 'disabled' | 'unknown';

export function deriveOnlineLaneStatus(explanation: ContractValidation): OnlineLaneStatus {
  if (!explanation.ok) return 'unknown';
  const classes = deriveSourceClasses(explanation);
  return classes.some((entry) => entry === 'web evidence' || entry === 'web promoted') ? 'enabled' : 'disabled';
}

function normalizePolicyRetrievalModeCandidate(value: unknown): PolicyRetrievalMode {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
  if (normalized === 'documents_only') return 'documents_only';
  if (normalized === 'regression_test') return 'regression_test';
  if (normalized === 'task_memory') return 'task_memory';
  if (normalized === 'full_memory') return 'full_memory';
  return 'unknown';
}

function inferPolicyRetrievalModeFromIntent(intentFamilyRaw: unknown): PolicyRetrievalMode {
  const intentFamily = String(intentFamilyRaw ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
  if (!intentFamily) return 'unknown';
  if (intentFamily.includes('task') || intentFamily.includes('workflow') || intentFamily.includes('state')) return 'task_memory';
  if (intentFamily.includes('price') || intentFamily.includes('web') || intentFamily.includes('investigative'))
    return 'full_memory';
  if (
    intentFamily.includes('architecture') ||
    intentFamily.includes('corpus') ||
    intentFamily.includes('document') ||
    intentFamily.includes('quote') ||
    intentFamily.includes('recall')
  ) {
    return 'documents_only';
  }
  return 'unknown';
}

export function derivePolicyRetrievalMode(
  explanation: ContractValidation,
): { mode: PolicyRetrievalMode; source: PolicyModeSource } {
  if (!explanation.ok) return { mode: 'unknown', source: 'unknown' };
  const backendMode = normalizePolicyRetrievalModeCandidate(explanation.value.retrieval_mode);
  if (backendMode !== 'unknown') return { mode: backendMode, source: 'backend' };
  const inferredMode = inferPolicyRetrievalModeFromIntent(explanation.value.intent_family);
  return {
    mode: inferredMode,
    source: inferredMode === 'unknown' ? 'unknown' : 'inferred',
  };
}

function classifyMemoryLayer(memoryTypeRaw: unknown, laneRaw: unknown): NormalizedMemoryLayerId {
  const memoryType = normalizeMemoryType(memoryTypeRaw);
  const lane = normalizeLane(laneRaw);
  if (memoryType.includes('web_promoted')) return 'web_promoted_memory';
  if (memoryType.includes('web_evidence') || lane === 'web') return 'web_evidence_memory';
  if (memoryType.includes('large_file') || lane === 'large_file') return 'large_file_memory';
  if (memoryType.includes('corpus') || lane === 'corpus') return 'corpus_memory';
  if (memoryType.includes('task') || lane === 'task') return 'task_memory';
  if (memoryType.includes('profile') || lane === 'profile') return 'profile_memory';
  if (memoryType.includes('reasoning') || lane === 'reasoning') return 'reasoning_memory';
  if (memoryType.includes('procedural') || lane === 'procedural') return 'procedural_memory';
  if (memoryType.includes('semantic') || memoryType.includes('promoted') || lane === 'promoted') return 'semantic_memory';
  if (memoryType.includes('episodic') || memoryType.includes('session') || lane === 'episodic') return 'episodic_memory';
  if (memoryType.includes('mirror') || lane === 'mirror') return 'mirror_memory';
  return 'working_memory';
}

const MEMORY_LAYER_ORDER: readonly NormalizedMemoryLayerId[] = [
  'working_memory',
  'episodic_memory',
  'semantic_memory',
  'procedural_memory',
  'task_memory',
  'profile_memory',
  'reasoning_memory',
  'corpus_memory',
  'large_file_memory',
  'web_evidence_memory',
  'web_promoted_memory',
  'mirror_memory',
];

export function deriveNormalizedMemoryClassMix(explanation: ContractValidation): NormalizedMemoryClassEntry[] {
  if (!explanation.ok) return [];
  const bucket = new Map<NormalizedMemoryLayerId, NormalizedMemoryClassEntry>();
  const add = (layerId: NormalizedMemoryLayerId, laneRaw: unknown, memoryTypeRaw: unknown, laneTokens: number) => {
    const lane = normalizeLane(laneRaw);
    const memoryType = normalizeMemoryType(memoryTypeRaw);
    const current = bucket.get(layerId) ?? {
      layerId,
      selectedBlockCount: 0,
      laneTokens: 0,
      observedLanes: [],
      observedMemoryTypes: [],
    };
    if (lane && !current.observedLanes.includes(lane)) current.observedLanes.push(lane);
    if (memoryType && !current.observedMemoryTypes.includes(memoryType)) current.observedMemoryTypes.push(memoryType);
    current.selectedBlockCount += 1;
    current.laneTokens = Math.max(current.laneTokens, laneTokens);
    bucket.set(layerId, current);
  };

  const laneTotals = explanation.value.lane_totals || {};
  for (const block of explanation.value.selected_blocks || []) {
    const lane = normalizeLane(block?.lane);
    const laneTokens = Number.isFinite(laneTotals[lane]) ? Math.max(0, Math.floor(Number(laneTotals[lane]))) : 0;
    add(classifyMemoryLayer(block?.memory_type, block?.lane), block?.lane, block?.memory_type, laneTokens);
  }
  for (const [laneRaw, tokens] of Object.entries(laneTotals)) {
    const layerId = classifyMemoryLayer('', laneRaw);
    const laneTokens = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
    const current = bucket.get(layerId) ?? {
      layerId,
      selectedBlockCount: 0,
      laneTokens: 0,
      observedLanes: [],
      observedMemoryTypes: [],
    };
    const lane = normalizeLane(laneRaw);
    if (lane && !current.observedLanes.includes(lane)) current.observedLanes.push(lane);
    current.laneTokens = Math.max(current.laneTokens, laneTokens);
    bucket.set(layerId, current);
  }
  return MEMORY_LAYER_ORDER.map((layerId) => bucket.get(layerId)).filter((entry): entry is NormalizedMemoryClassEntry => !!entry);
}

function isWebPromotedMemoryType(memoryTypeRaw: unknown): boolean {
  const memoryType = normalizeMemoryType(memoryTypeRaw);
  return memoryType.includes('web_promoted');
}

function isWebEvidenceMemoryType(memoryTypeRaw: unknown): boolean {
  const memoryType = normalizeMemoryType(memoryTypeRaw);
  return memoryType.includes('web_evidence') || memoryType === 'web';
}

export function deriveWebClassReadbackSummary(explanation: ContractValidation): WebClassReadbackSummary | null {
  if (!explanation.ok) return null;

  const webEvidence: WebClassReadbackEntry = {
    storageClass: 'staged_external_evidence',
    readbackBlockCount: 0,
    selectedBlockIds: [],
    observedMemoryTypes: [],
    provenanceBackedCount: 0,
  };
  const webPromoted: WebClassReadbackEntry = {
    storageClass: 'promoted_reusable_web_knowledge',
    readbackBlockCount: 0,
    selectedBlockIds: [],
    observedMemoryTypes: [],
    provenanceBackedCount: 0,
  };

  for (const block of explanation.value.selected_blocks || []) {
    const lane = normalizeLane(block?.lane);
    const memoryType = normalizeMemoryType(block?.memory_type);
    const isPromoted = isWebPromotedMemoryType(block?.memory_type);
    const isEvidence = isWebEvidenceMemoryType(block?.memory_type) || lane === 'web';
    if (!isEvidence && !isPromoted) continue;

    const target = isPromoted ? webPromoted : webEvidence;
    target.readbackBlockCount += 1;
    const id = String(block?.id ?? '').trim();
    if (id && !target.selectedBlockIds.includes(id)) target.selectedBlockIds.push(id);
    if (memoryType && !target.observedMemoryTypes.includes(memoryType)) target.observedMemoryTypes.push(memoryType);
    if (block?.provenance && typeof block.provenance === 'object') target.provenanceBackedCount += 1;
  }

  return {
    webEvidence,
    webPromoted,
    collapsedWebBucket: false,
  };
}

function isReasoningMemoryType(memoryTypeRaw: unknown): boolean {
  const memoryType = normalizeMemoryType(memoryTypeRaw);
  return memoryType.includes('reasoning');
}

function isGenericPromotedMemoryType(memoryTypeRaw: unknown): boolean {
  const memoryType = normalizeMemoryType(memoryTypeRaw);
  if (isWebPromotedMemoryType(memoryTypeRaw)) return false;
  return memoryType.includes('promoted') || memoryType.includes('semantic');
}

export function deriveReasoningReuseSummary(explanation: ContractValidation): ReasoningReuseSummary | null {
  if (!explanation.ok) return null;
  const summary: ReasoningReuseSummary = {
    reasoningReuseVisible: false,
    reasoningReuseBlockIds: [],
    reasoningReuseMemoryTypes: [],
    reasoningProvenanceCount: 0,
    genericPromotedBlockIds: [],
    genericPromotedMemoryTypes: [],
    genericPromotedProvenanceCount: 0,
    collapsedIntoGenericPromoted: false,
  };

  for (const block of explanation.value.selected_blocks || []) {
    const id = String(block?.id ?? '').trim();
    const memoryType = normalizeMemoryType(block?.memory_type);
    if (isReasoningMemoryType(block?.memory_type)) {
      summary.reasoningReuseVisible = true;
      if (id && !summary.reasoningReuseBlockIds.includes(id)) summary.reasoningReuseBlockIds.push(id);
      if (memoryType && !summary.reasoningReuseMemoryTypes.includes(memoryType))
        summary.reasoningReuseMemoryTypes.push(memoryType);
      if (block?.provenance && typeof block.provenance === 'object') summary.reasoningProvenanceCount += 1;
      continue;
    }
    if (isGenericPromotedMemoryType(block?.memory_type) || normalizeLane(block?.lane) === 'promoted') {
      if (id && !summary.genericPromotedBlockIds.includes(id)) summary.genericPromotedBlockIds.push(id);
      if (memoryType && !summary.genericPromotedMemoryTypes.includes(memoryType))
        summary.genericPromotedMemoryTypes.push(memoryType);
      if (block?.provenance && typeof block.provenance === 'object') summary.genericPromotedProvenanceCount += 1;
    }
  }

  return summary;
}
