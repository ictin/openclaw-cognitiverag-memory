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

