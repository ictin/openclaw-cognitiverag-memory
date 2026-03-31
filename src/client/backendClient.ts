import { validateSelectionExplanation, type ContractValidation } from '../validators/contractValidator.js';

export type BackendAssembleRequest = {
  sessionId: string;
  freshTailCount: number;
  budget: number;
  query?: string;
  intentFamily?: string | null;
};

export type BackendAssembleResponse = {
  status: number;
  body: any;
  explanation: ContractValidation;
};

export type SkillPackBuildRequest = {
  query: string;
  agentType: 'script_agent' | 'storyboard_agent';
  taskType: string;
  channelType?: string;
  language?: string;
  styleProfile?: string;
  maxItems?: number;
};

export type SkillPackBuildResponse = {
  status: number;
  body: any;
};

export type ExecutionCaseWriteRequest = {
  agentType: string;
  taskType: string;
  requestText: string;
  selectedArtifactIds: string[];
  channelType?: string;
  language?: string;
  packSummary?: string;
  outputText?: string;
  successFlag?: boolean;
  notes?: string;
  humanEdits?: string[];
};

export type EvaluationCaseWriteRequest = {
  executionCaseId: string;
  agentType: string;
  taskType: string;
  channelType?: string;
  language?: string;
  rubricId?: string;
  rubricRef?: string;
  criterionScores: Array<{
    criterionId: string;
    label: string;
    score: number;
    maxScore?: number;
    weight?: number;
    notes?: string;
  }>;
  passFlag?: boolean;
  antiPatternHits?: string[];
  strengths?: string[];
  weaknesses?: string[];
  humanEditsSummary?: string;
  improvementNotes?: string[];
};

export type ExecutionCaseResponse = {
  status: number;
  body: any;
};

export type ExecutionSimilarRequest = {
  query: string;
  agentType?: string;
  taskType?: string;
  channelType?: string;
  language?: string;
  limit?: number;
};

export type EvaluationsQuery = {
  executionCaseId?: string;
  agentType?: string;
  taskType?: string;
  channelType?: string;
  language?: string;
  passFlag?: boolean;
  limit?: number;
};

export async function fetchBackendAssembleContext(
  baseUrl: string,
  request: BackendAssembleRequest,
  timeoutMs = 3000,
): Promise<BackendAssembleResponse> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/session_assemble_context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: request.sessionId,
        fresh_tail_count: request.freshTailCount,
        budget: request.budget,
        query: request.query ?? null,
        intent_family: request.intentFamily ?? null,
      }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    return {
      status: Number(res.status ?? 0),
      body,
      explanation: validateSelectionExplanation((body as any)?.explanation),
    };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchSkillPackBuild(baseUrl: string, request: SkillPackBuildRequest): Promise<SkillPackBuildResponse> {
  const res = await fetch(`${baseUrl}/skill_memory/build_pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: request.query,
      agent_type: request.agentType,
      task_type: request.taskType,
      channel_type: request.channelType ?? '',
      language: request.language ?? '',
      style_profile: request.styleProfile ?? '',
      max_items: request.maxItems ?? 12,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}

export async function writeExecutionCase(baseUrl: string, request: ExecutionCaseWriteRequest): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/skill_memory/execution_case`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_type: request.agentType,
      task_type: request.taskType,
      request_text: request.requestText,
      selected_artifact_ids: request.selectedArtifactIds,
      channel_type: request.channelType ?? '',
      language: request.language ?? '',
      pack_summary: request.packSummary ?? '',
      output_text: request.outputText ?? '',
      success_flag: request.successFlag ?? false,
      notes: request.notes ?? '',
      human_edits: request.humanEdits ?? [],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}

export async function writeEvaluationCase(baseUrl: string, request: EvaluationCaseWriteRequest): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/skill_memory/evaluation_case`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      execution_case_id: request.executionCaseId,
      agent_type: request.agentType,
      task_type: request.taskType,
      channel_type: request.channelType ?? '',
      language: request.language ?? '',
      rubric_id: request.rubricId ?? '',
      rubric_ref: request.rubricRef ?? '',
      criterion_scores: (request.criterionScores ?? []).map((c) => ({
        criterion_id: c.criterionId,
        label: c.label,
        score: c.score,
        max_score: c.maxScore ?? 5,
        weight: c.weight ?? 1,
        notes: c.notes ?? '',
      })),
      pass_flag: request.passFlag,
      anti_pattern_hits: request.antiPatternHits ?? [],
      strengths: request.strengths ?? [],
      weaknesses: request.weaknesses ?? [],
      human_edits_summary: request.humanEditsSummary ?? '',
      improvement_notes: request.improvementNotes ?? [],
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}

export async function fetchExecutionCase(baseUrl: string, executionCaseId: string): Promise<ExecutionCaseResponse> {
  const id = encodeURIComponent(String(executionCaseId ?? '').trim());
  const res = await fetch(`${baseUrl}/skill_memory/execution_case/${id}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}

export async function fetchExecutionSimilar(baseUrl: string, request: ExecutionSimilarRequest): Promise<{ status: number; body: any }> {
  const params = new URLSearchParams();
  params.set('query', String(request.query ?? '').trim());
  if (request.agentType) params.set('agent_type', String(request.agentType));
  if (request.taskType) params.set('task_type', String(request.taskType));
  if (request.channelType) params.set('channel_type', String(request.channelType));
  if (request.language) params.set('language', String(request.language));
  params.set('limit', String(Math.max(1, Math.min(20, Number(request.limit ?? 6)))));
  const res = await fetch(`${baseUrl}/skill_memory/execution_similar?${params.toString()}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}

export async function fetchEvaluations(baseUrl: string, request: EvaluationsQuery): Promise<{ status: number; body: any }> {
  const params = new URLSearchParams();
  if (request.executionCaseId) params.set('execution_case_id', String(request.executionCaseId));
  if (request.agentType) params.set('agent_type', String(request.agentType));
  if (request.taskType) params.set('task_type', String(request.taskType));
  if (request.channelType) params.set('channel_type', String(request.channelType));
  if (request.language) params.set('language', String(request.language));
  if (typeof request.passFlag === 'boolean') params.set('pass_flag', request.passFlag ? 'true' : 'false');
  params.set('limit', String(Math.max(1, Math.min(20, Number(request.limit ?? 6)))));
  const res = await fetch(`${baseUrl}/skill_memory/evaluations?${params.toString()}`, { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  return { status: Number(res.status ?? 0), body };
}
