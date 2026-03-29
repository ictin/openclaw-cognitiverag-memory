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
