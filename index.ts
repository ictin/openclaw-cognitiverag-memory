import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fsSync from 'node:fs';
import { summarizeFallback } from './lib/fallbackMemorySummarizer.js';

const COG_RAG_BASE = 'http://127.0.0.1:8000';

type AssembleShapeResult = {
  messages: any[];
  systemPromptAddition?: string;
  estimatedTokens: number;
  totalTokens: number;
};

type EngineAssembleResult = {
  messages: any[];
  estimatedTokens: number;
  totalTokens: number;
  usage: {
    estimatedTokens: number;
    totalTokens: number;
  };
  source: {
    estimatedTokens: number;
    totalTokens: number;
  };
  systemPromptAddition?: string;
};

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const typed = part as Record<string, unknown>;
        if (typeof typed.text === 'string') return typed.text;
        if (typeof typed.content === 'string') return typed.content;
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    const typed = content as Record<string, unknown>;
    if (typeof typed.text === 'string') return typed.text;
    if (typeof typed.content === 'string') return typed.content;
  }
  return '';
}

function toContentBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
  const text = extractTextContent(content).trim();
  if (!text) return [];
  return [{ type: 'text', text }];
}

function extractDurableFactCandidate(rawText: string): string | null {
  const text = String(rawText ?? '').trim();
  if (!text) return null;

  const linePatterns = [
    /^(?:remember(?:\s+this)?(?:\s+exact)?(?:\s+durable)?(?:\s+fact)?(?:\s+for\s+later)?|remember)\s*:\s*(.+)$/i,
    /^durable fact to remember exactly\s*:\s*(.+)$/i,
  ];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (const line of lines) {
    for (const re of linePatterns) {
      const match = line.match(re);
      if (!match) continue;
      const candidate = String(match[1] ?? '').trim();
      if (!candidate) continue;
      return candidate.length > 500 ? candidate.slice(0, 500) : candidate;
    }
  }

  const inlineMatch = text.match(
    /remember(?:\s+this)?(?:\s+exact)?(?:\s+durable)?(?:\s+fact)?(?:\s+for\s+later)?\s*:\s*([^\n\r]+)/i,
  );
  if (inlineMatch?.[1]) {
    const candidate = String(inlineMatch[1]).trim();
    if (candidate) return candidate.length > 500 ? candidate.slice(0, 500) : candidate;
  }

  return null;
}

export function shapeAssembleResponse(assemblyRes: any, budget = 4096): AssembleShapeResult {
  const freshTail = Array.isArray(assemblyRes?.body?.fresh_tail) ? assemblyRes.body.fresh_tail : [];
  const summaries = Array.isArray(assemblyRes?.body?.summaries) ? assemblyRes.body.summaries : [];
  const contextBlock = assemblyRes?.body?.context_block ?? null;

  const exactContextItems = Array.isArray(contextBlock?.exact_items) ? contextBlock.exact_items : [];
  const derivedContextItems = Array.isArray(contextBlock?.derived_items) ? contextBlock.derived_items : [];
  const contextProvenance = contextBlock?.provenance ?? null;

  const structuredContextMessages = [
    ...exactContextItems.map((item: any) => ({
      role: 'user',
      content: toContentBlocks(item?.content ?? item?.summary ?? item?.text ?? ''),
      metadata: {
        item_type: item?.item_type ?? 'exact_item',
        exactness: item?.exactness ?? 'exact',
        summarizable: item?.summarizable ?? false,
        provenance: item?.provenance ?? contextProvenance ?? null,
      },
    })),
    ...derivedContextItems.map((item: any) => ({
      role: 'system',
      content: toContentBlocks(item?.summary ?? item?.content ?? item?.text ?? ''),
      metadata: {
        item_type: item?.item_type ?? 'derived_item',
        exactness: item?.exactness ?? 'derived',
        summarizable: item?.summarizable ?? true,
        provenance: item?.provenance ?? contextProvenance ?? null,
      },
    })),
  ].filter((m: any) => extractTextContent(m?.content).trim());

  const messages = structuredContextMessages.length
    ? structuredContextMessages
    : freshTail
        .map((m: any) => {
          const sender = String(m?.sender ?? 'user');
          const text = String(m?.text ?? '');
          if (!text) return null;
          return {
            role: sender === 'assistant' ? 'assistant' : 'user',
            content: toContentBlocks(text),
          };
        })
        .filter((msg: any) => msg && extractTextContent(msg.content).trim());

  const rawSummaryItems = structuredContextMessages.length
    ? []
    : summaries
        .map((s: any) => String(s?.summary ?? '').trim())
        .filter(Boolean)
        .slice(0, 8);

  const maxSummaryTokens = Math.min(512, Math.max(96, Math.floor(budget * 0.25)));
  const maxSummaryChars = maxSummaryTokens * 4;
  const summaryItems: string[] = [];
  let usedChars = 0;
  for (const item of rawSummaryItems) {
    const prefixChars = summaryItems.length === 0 ? 0 : 3;
    if (usedChars + prefixChars + item.length <= maxSummaryChars) {
      summaryItems.push(item);
      usedChars += prefixChars + item.length;
      continue;
    }
    const remaining = maxSummaryChars - usedChars - prefixChars;
    if (remaining > 24) {
      summaryItems.push(item.slice(0, remaining - 1) + '…');
    }
    break;
  }

  const summaryText = summaryItems.join('\n- ');
  const systemPromptAddition = structuredContextMessages.length
    ? undefined
    : summaryText
      ? `Memory summary (older context; use as background, prefer fresh tail for exact wording):\n- ${summaryText}`
      : undefined;

  const estimatedTokens = Math.max(
    0,
    messages.reduce((n: number, m: any) => n + Math.ceil(extractTextContent(m?.content).length / 4), 0) +
      Math.ceil((systemPromptAddition ?? '').length / 4),
  );
  const totalTokens = estimatedTokens;

  return { messages, systemPromptAddition, estimatedTokens, totalTokens };
}

export function toEngineAssembleResult(shaped: AssembleShapeResult): EngineAssembleResult {
  const messages = Array.isArray(shaped?.messages)
    ? shaped.messages
        .map((message: any) => {
          const role = String(message?.role ?? 'user');
          const content = toContentBlocks(message?.content);
          const contentText = extractTextContent(content);
          if (!contentText.trim()) return null;
          const messageEstimatedTokens = Math.max(0, Math.ceil(contentText.length / 4));
          const messageTotalTokens = Number.isFinite(message?.usage?.totalTokens)
            ? Math.max(0, Number(message.usage.totalTokens))
            : Number.isFinite(message?.source?.totalTokens)
              ? Math.max(0, Number(message.source.totalTokens))
              : messageEstimatedTokens;
          return {
            ...message,
            role: role === 'assistant' || role === 'system' ? role : 'user',
            content,
            usage:
              message?.usage && typeof message.usage === 'object'
                ? {
                    ...message.usage,
                    totalTokens: Number.isFinite(message?.usage?.totalTokens)
                      ? Math.max(0, Number(message.usage.totalTokens))
                      : messageTotalTokens,
                  }
                : {
                    totalTokens: messageTotalTokens,
                    estimatedTokens: messageEstimatedTokens,
                  },
            source:
              message?.source && typeof message.source === 'object'
                ? {
                    ...message.source,
                    totalTokens: Number.isFinite(message?.source?.totalTokens)
                      ? Math.max(0, Number(message.source.totalTokens))
                      : messageTotalTokens,
                  }
                : {
                    totalTokens: messageTotalTokens,
                    estimatedTokens: messageEstimatedTokens,
                  },
          };
        })
        .filter(Boolean)
    : [];
  const estimatedTokens = Number.isFinite(shaped?.estimatedTokens) ? Math.max(0, shaped.estimatedTokens) : 0;
  const totalTokens = Number.isFinite(shaped?.totalTokens)
    ? Math.max(0, shaped.totalTokens)
    : Number.isFinite(shaped?.estimatedTokens)
      ? Math.max(0, shaped.estimatedTokens)
      : 0;
  return {
    messages,
    estimatedTokens,
    totalTokens,
    usage: {
      estimatedTokens,
      totalTokens,
    },
    source: {
      estimatedTokens,
      totalTokens,
    },
    ...(typeof shaped?.systemPromptAddition === 'string' && shaped.systemPromptAddition.trim()
      ? { systemPromptAddition: shaped.systemPromptAddition }
      : {}),
  };
}

type PluginMode = 'summary_only' | 'summary_plus_retrieved_facts' | 'full_external_tail';
const DEFAULT_PLUGIN_MODE: PluginMode = 'summary_only';

type HealthMode = 'healthy' | 'degraded' | 'offline' | 'unknown' | 'rolled_back';
type HealthState = {
  backendReachable: boolean;
  mode: HealthMode;
  lastSuccessAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  contextEngineSlot: string;
  fallbackMemoryMirrorActive: boolean;
  rollbackRecommended: boolean;
  rollbackReason: string | null;
  rollbackReady: boolean;
  lastRollbackAt: string | null;
};

type RecallHit = {
  source:
    | 'backend_session_memory'
    | 'fallback_mirror_plugin'
    | 'fallback_mirror_workspace'
    | 'lossless_session_raw'
    | 'lossless_session_compact';
  text: string;
  sessionId?: string;
  chunkId?: string;
};

type SessionPart = {
  type: string;
  text: string;
};

type RawSessionEntry = {
  seq: number;
  ts: string;
  sessionId: string;
  sessionKey: string | null;
  messageId: string;
  role: string;
  sender: 'user' | 'assistant';
  text: string;
  parts: SessionPart[];
};

type CompactSessionItem = {
  chunkId: string;
  sessionId: string;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  summary: string;
  sample: string[];
  updatedAt: string;
};

type CompactSessionStore = {
  sessionId: string;
  generatedAt: string;
  freshTailCount: number;
  chunkSize: number;
  totalRawEntries: number;
  items: CompactSessionItem[];
};

const LOCAL_FRESH_TAIL_COUNT = 12;
const LOCAL_COMPACT_CHUNK_SIZE = 8;

function toSafeSessionFilePart(sessionId: string): string {
  const id = String(sessionId ?? '').trim() || 'unknown-session';
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeParts(content: unknown): SessionPart[] {
  if (Array.isArray(content)) {
    const out: SessionPart[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        const text = part.trim();
        if (text) out.push({ type: 'text', text });
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const typed = part as Record<string, unknown>;
      const text = extractTextContent(typed).trim();
      if (!text) continue;
      out.push({
        type: typeof typed.type === 'string' ? typed.type : 'text',
        text,
      });
    }
    return out;
  }
  const text = extractTextContent(content).trim();
  return text ? [{ type: 'text', text }] : [];
}

function summarizeCompactChunk(chunk: RawSessionEntry[]): { summary: string; sample: string[] } {
  const lines: string[] = [];
  const sample: string[] = [];
  for (const entry of chunk) {
    const prefix = entry.sender === 'assistant' ? 'A' : 'U';
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const trimmed = text.length > 200 ? `${text.slice(0, 199)}…` : text;
    const line = `${prefix}: ${trimmed}`;
    if (sample.length < 4) sample.push(line);
    if (lines.length < 8) lines.push(line);
  }
  const summary = lines.join('\n');
  return {
    summary: summary || '(no text in this chunk)',
    sample,
  };
}

const defaultHealthState = (): HealthState => ({
  backendReachable: false,
  mode: 'unknown',
  lastSuccessAt: null,
  lastFailAt: null,
  lastError: null,
  consecutiveFailures: 0,
  contextEngineSlot: 'unknown',
  fallbackMemoryMirrorActive: false,
  rollbackRecommended: false,
  rollbackReason: null,
  rollbackReady: true,
  lastRollbackAt: null,
});

function withTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function postJson(path: string, body: any, timeoutMs = 3000) {
  const t = withTimeoutSignal(timeoutMs);
  try {
    const r = await fetch(`${COG_RAG_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    let parsed: any = null;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed };
  } finally {
    t.done();
  }
}

export default function register(api: any) {
  const pluginRoot = path.resolve(path.dirname(api?.source ?? api?.path ?? path.resolve('.')));
  const healthFile = path.join(pluginRoot, 'crag-health-state.json');
  const memoryFile = path.join(pluginRoot, 'MEMORY.md');
  const workspaceMemoryFile = path.join(process.cwd(), 'MEMORY.md');
  const sessionMemoryDir = path.join(pluginRoot, 'session_memory');
  const sessionExportDir = path.join(pluginRoot, 'session_exports');
  const bootstrappedSlot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');
  const observedSessionIdsByKey = new Map<string, string>();
  let lastObservedSessionId = '';

  try {
    api.logger?.info?.('[cognitiverag-memory] register-time path debug', {
      apiId: api?.id ?? null,
      apiSource: api?.source ?? null,
      apiRootDir: api?.rootDir ?? null,
      processCwd: process.cwd(),
      pluginRootCandidate: pluginRoot,
      healthFileCandidate: healthFile,
    });
    const diagPath = '/tmp/cognitiverag-plugin-bootstrap-diagnostic.json';
    const diag = {
      timestamp: new Date().toISOString(),
      apiId: api?.id ?? null,
      apiSource: api?.source ?? null,
      apiRootDir: api?.rootDir ?? null,
      typeofApiSource: typeof api?.source,
      typeofApiRootDir: typeof api?.rootDir,
      processCwd: process.cwd(),
      pluginRootCandidate: pluginRoot,
      healthFile,
      pluginRootExists: fsSync.existsSync(pluginRoot),
      healthDirExists: fsSync.existsSync(path.dirname(healthFile)),
    };
    try {
      fsSync.writeFileSync(diagPath, JSON.stringify(diag, null, 2));
    } catch {}
    const dir = healthFile.includes('/') ? healthFile.slice(0, healthFile.lastIndexOf('/')) : '.';
    if (dir) {
      try {
        fsSync.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    if (!fsSync.existsSync(healthFile)) {
      const initialState = {
        ...defaultHealthState(),
        backendReachable: false,
        mode: 'unknown',
        lastSuccessAt: null,
        lastFailAt: null,
        lastError: null,
        consecutiveFailures: 0,
        contextEngineSlot: bootstrappedSlot,
        fallbackMemoryMirrorActive: false,
        rollbackRecommended: false,
        rollbackReason: null,
        rollbackReady: true,
        lastRollbackAt: null,
      };
      fsSync.writeFileSync(healthFile, JSON.stringify(initialState, null, 2));
    }
  } catch {
    // keep bootstrapping best-effort and non-fatal
  }

  const readHealthState = async (): Promise<HealthState> => {
    try {
      const raw = await fs.readFile(healthFile, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...defaultHealthState(),
        ...parsed,
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? parsed?.contextEngineSlot ?? 'unknown'),
      };
    } catch {
      return {
        ...defaultHealthState(),
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
      };
    }
  };

  const writeHealthState = async (next: Partial<HealthState>) => {
    try {
      const current = await readHealthState();
      const merged: HealthState = {
        ...current,
        ...next,
        contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? current.contextEngineSlot ?? 'unknown'),
      };
      await fs.writeFile(healthFile, JSON.stringify(merged, null, 2));
      return merged;
    } catch {
      return null;
    }
  };

  const markSuccess = async () => {
    const now = new Date().toISOString();
    return writeHealthState({
      backendReachable: true,
      mode: 'healthy',
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      rollbackRecommended: false,
      rollbackReason: null,
    });
  };

  const appendRememberEntry = async (rawText: string) => {
    try {
      const text = String(rawText ?? '').trim();
      if (!text) return { ok: false, reason: 'empty' as const };
      const line = `- ${text}`;
      const existing = await fs.readFile(memoryFile, 'utf8').catch(() => '');
      if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
        return { ok: true, duplicate: true as const, line };
      }
      const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
      await fs.writeFile(memoryFile, next);
      return { ok: true, duplicate: false as const, line };
    } catch (error: any) {
      api.logger?.warn?.(`[cognitiverag-memory] remember mirror failed ${String(error?.message ?? error)}`);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  };

  const promoteDurableFactToMirror = async (rawText: string, source: string) => {
    const candidate = extractDurableFactCandidate(rawText);
    if (!candidate) return { promoted: false, reason: 'no_candidate' as const };
    const res = await appendRememberEntry(candidate);
    if (res?.ok) {
      await writeHealthState({ fallbackMemoryMirrorActive: true });
      api.logger?.info?.(
        `[cognitiverag-memory] promoted durable fact to fallback mirror ${JSON.stringify({
          source,
          candidateChars: candidate.length,
          duplicate: !!(res as any)?.duplicate,
        })}`,
      );
      return { promoted: true, duplicate: !!(res as any)?.duplicate };
    }
    api.logger?.warn?.(
      `[cognitiverag-memory] fallback mirror promotion skipped ${JSON.stringify({
        source,
        reason: (res as any)?.reason ?? 'unknown',
      })}`,
    );
    return { promoted: false, reason: 'write_failed' as const };
  };

  const markFail = async (err: unknown) => {
    const current = await readHealthState();
    const now = new Date().toISOString();
    const msg = String((err as any)?.message ?? err ?? 'unknown error');
    const failures = Number(current?.consecutiveFailures ?? 0) + 1;
    const rollbackRecommended = failures >= 3;
    return writeHealthState({
      backendReachable: false,
      mode: rollbackRecommended ? 'rolled_back' : 'degraded',
      lastFailAt: now,
      lastError: msg,
      consecutiveFailures: failures,
      rollbackRecommended,
      rollbackReason: rollbackRecommended ? msg : current?.rollbackReason ?? null,
      rollbackReady: true,
      lastRollbackAt: rollbackRecommended ? now : current?.lastRollbackAt ?? null,
    });
  };

  const probeBackend = async () => {
    try {
      const probe = await postJson(
        '/session_assemble_context',
        {
          session_id: '__crag_probe__',
          fresh_tail_count: 0,
          budget: 256,
        },
        1500,
      );
      if (probe.status >= 200 && probe.status < 300) {
        const state = await markSuccess();
        return { ok: true, state, backendReachable: true, mode: 'healthy' as const };
      }
      const state = await markFail(`probe_status_${probe.status}`);
      return {
        ok: false,
        state,
        backendReachable: false,
        mode: state?.mode ?? 'degraded',
        reason: `HTTP ${probe.status}`,
      };
    } catch (e) {
      const state = await markFail(e);
      return { ok: false, state, reason: String((e as any)?.message ?? e) };
    }
  };

  const rememberObservedSession = (sessionKey: unknown, sessionId: unknown) => {
    const key = String(sessionKey ?? '').trim();
    const id = String(sessionId ?? '').trim();
    if (!id || id === 'unknown-session') return;
    lastObservedSessionId = id;
    if (key) observedSessionIdsByKey.set(key, id);
  };

  const resolveSessionPath = (kind: 'raw' | 'compact', sessionId: string) => {
    const safe = toSafeSessionFilePart(sessionId);
    const file =
      kind === 'raw' ? path.join(sessionMemoryDir, `raw_${safe}.jsonl`) : path.join(sessionMemoryDir, `compact_${safe}.json`);
    return file;
  };

  const readRawEntries = async (sessionId: string): Promise<RawSessionEntry[]> => {
    const file = resolveSessionPath('raw', sessionId);
    try {
      const text = await fs.readFile(file, 'utf8');
      const entries = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry): entry is RawSessionEntry => !!entry && typeof entry === 'object');
      return entries
        .filter((entry) => Number.isFinite(entry.seq))
        .sort((a, b) => Number(a.seq) - Number(b.seq));
    } catch {
      return [];
    }
  };

  const readCompactStore = async (sessionId: string): Promise<CompactSessionStore | null> => {
    const file = resolveSessionPath('compact', sessionId);
    try {
      const text = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as CompactSessionStore;
    } catch {
      return null;
    }
  };

  const ensureSessionStoreDirs = async () => {
    await fs.mkdir(sessionMemoryDir, { recursive: true });
    await fs.mkdir(sessionExportDir, { recursive: true });
  };

  const rebuildCompaction = async (sessionId: string): Promise<CompactSessionStore> => {
    const entries = await readRawEntries(sessionId);
    const olderCount = Math.max(0, entries.length - LOCAL_FRESH_TAIL_COUNT);
    const older = olderCount > 0 ? entries.slice(0, olderCount) : [];
    const items: CompactSessionItem[] = [];
    for (let i = 0; i < older.length; i += LOCAL_COMPACT_CHUNK_SIZE) {
      const chunk = older.slice(i, i + LOCAL_COMPACT_CHUNK_SIZE);
      if (!chunk.length) continue;
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const compact = summarizeCompactChunk(chunk);
      items.push({
        chunkId: `chunk-${first.seq}-${last.seq}`,
        sessionId,
        startSeq: first.seq,
        endSeq: last.seq,
        messageCount: chunk.length,
        summary: compact.summary,
        sample: compact.sample,
        updatedAt: new Date().toISOString(),
      });
    }
    const store: CompactSessionStore = {
      sessionId,
      generatedAt: new Date().toISOString(),
      freshTailCount: LOCAL_FRESH_TAIL_COUNT,
      chunkSize: LOCAL_COMPACT_CHUNK_SIZE,
      totalRawEntries: entries.length,
      items,
    };
    await ensureSessionStoreDirs();
    await fs.writeFile(resolveSessionPath('compact', sessionId), JSON.stringify(store, null, 2));
    return store;
  };

  const appendRawSessionEntry = async (
    sessionId: string,
    sessionKey: string,
    messageId: string,
    role: string,
    sender: 'user' | 'assistant',
    content: unknown,
  ) => {
    await ensureSessionStoreDirs();
    const file = resolveSessionPath('raw', sessionId);
    const existing = await readRawEntries(sessionId);
    const entry: RawSessionEntry = {
      seq: existing.length + 1,
      ts: new Date().toISOString(),
      sessionId,
      sessionKey: sessionKey || null,
      messageId,
      role,
      sender,
      text: extractTextContent(content),
      parts: normalizeParts(content),
    };
    await fs.writeFile(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
    await rebuildCompaction(sessionId);
    return entry;
  };

  const listKnownSessionIds = async (): Promise<string[]> => {
    await ensureSessionStoreDirs();
    try {
      const files = await fs.readdir(sessionMemoryDir);
      const ids = files
        .map((name) => {
          const match = name.match(/^raw_(.+)\.jsonl$/);
          return match?.[1] ?? null;
        })
        .filter(Boolean)
        .map((v) => String(v));
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  };

  const collectLocalRecallHits = async (
    sessionId: string,
    query: string,
    includeCompacted: boolean,
  ): Promise<RecallHit[]> => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!sessionId || !q) return [];
    const rawEntries = await readRawEntries(sessionId);
    const hits: RecallHit[] = [];
    for (const entry of rawEntries) {
      const text = String(entry?.text ?? '').trim();
      if (!text) continue;
      if (!text.toLowerCase().includes(q)) continue;
      hits.push({
        source: 'lossless_session_raw',
        sessionId,
        text: `seq ${entry.seq} ${entry.sender}: ${text}`,
      });
      if (hits.length >= 8) return hits;
    }
    if (!includeCompacted) return hits;
    const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
    for (const item of compact.items) {
      const text = `${item.summary}\n${item.sample.join('\n')}`;
      if (!text.toLowerCase().includes(q)) continue;
      hits.push({
        source: 'lossless_session_compact',
        sessionId,
        chunkId: item.chunkId,
        text: `${item.chunkId} ${item.summary}`,
      });
      if (hits.length >= 8) return hits;
    }
    return hits;
  };

  const collectBackendRecallHits = async (sessionId: string, query: string): Promise<RecallHit[]> => {
    const trimmedQuery = String(query ?? '').trim().toLowerCase();
    if (!sessionId || !trimmedQuery) return [];
    try {
      const assembled = await postJson(
        '/session_assemble_context',
        {
          session_id: sessionId,
          fresh_tail_count: 200,
          budget: 8192,
        },
        2500,
      );
      const freshTail = Array.isArray(assembled?.body?.fresh_tail) ? assembled.body.fresh_tail : [];
      const summaries = Array.isArray(assembled?.body?.summaries) ? assembled.body.summaries : [];
      const contextBlock = assembled?.body?.context_block ?? null;
      const exactItems = Array.isArray(contextBlock?.exact_items) ? contextBlock.exact_items : [];
      const derivedItems = Array.isArray(contextBlock?.derived_items) ? contextBlock.derived_items : [];

      const candidates = [
        ...freshTail.map((m: any) => String(m?.text ?? '').trim()),
        ...summaries.map((s: any) => String(s?.summary ?? '').trim()),
        ...exactItems.map((i: any) => extractTextContent(i?.content ?? i?.summary ?? i?.text ?? '').trim()),
        ...derivedItems.map((i: any) => extractTextContent(i?.summary ?? i?.content ?? i?.text ?? '').trim()),
      ].filter(Boolean);

      const seen = new Set<string>();
      const hits: RecallHit[] = [];
      for (const candidate of candidates) {
        const normalized = candidate.toLowerCase();
        if (!normalized.includes(trimmedQuery)) continue;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        hits.push({ source: 'backend_session_memory', text: candidate });
        if (hits.length >= 8) break;
      }
      return hits;
    } catch {
      return [];
    }
  };

  const collectMirrorRecallHits = async (query: string): Promise<RecallHit[]> => {
    const trimmedQuery = String(query ?? '').trim().toLowerCase();
    if (!trimmedQuery) return [];
    const out: RecallHit[] = [];
    const collectFromFile = async (
      filePath: string,
      source: 'fallback_mirror_plugin' | 'fallback_mirror_workspace',
    ) => {
      try {
        const text = await fs.readFile(filePath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          const entry = line.trim();
          if (!entry.startsWith('-')) continue;
          if (!entry.toLowerCase().includes(trimmedQuery)) continue;
          out.push({ source, text: entry.replace(/^\-\s*/, '') });
          if (out.length >= 8) return;
        }
      } catch {
        // best-effort
      }
    };
    await collectFromFile(memoryFile, 'fallback_mirror_plugin');
    if (out.length < 8) await collectFromFile(workspaceMemoryFile, 'fallback_mirror_workspace');
    return out.slice(0, 8);
  };

  api.registerCommand?.({
    name: 'remember',
    description: 'Append an explicit durable memory note to the local fallback MEMORY.md.',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const note = Array.isArray(ctx?.args)
          ? ctx.args.join(' ').trim()
          : String(
              ctx?.args?.text ??
                ctx?.args?.message ??
                ctx?.args?.value ??
                ctx?.text ??
                ctx?.message ??
                ctx?.value ??
                ctx?.args ??
                '',
            ).trim();
        if (!note) return { text: 'Usage: /remember <durable fact or preference>' };
        const line = `- ${note}`;
        const existing = await fs.readFile(memoryFile, 'utf8').catch(() => '');
        if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
          return { text: 'Already remembered.' };
        }
        const header = existing.trim() ? '\n' : '# Fallback Memory Mirror\n';
        try {
          await fs.writeFile(
            '/tmp/remember-write-target-last.json',
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                pluginRoot,
                memoryFile,
                note,
                noteLength: note.length,
                cwd: process.cwd(),
              },
              null,
              2,
            ),
          );
        } catch {}
        await fs
          .writeFile(memoryFile, `${header}${line}\n`, { flag: existing ? 'a' : 'w' } as any)
          .catch(async () => {
            const current = existing.trim() ? existing : '# Fallback Memory Mirror\n';
            await fs.writeFile(memoryFile, `${current}${line}\n`);
          });
        await writeHealthState({ fallbackMemoryMirrorActive: true });
        return { text: `Remembered: ${note}` };
      } catch (error: any) {
        return { text: `Could not save memory: ${String(error?.message ?? error)}` };
      }
    },
  });

  api.registerCommand?.({
    name: 'crag-remember',
    description: 'Save a durable note to the workspace MEMORY.md fallback.',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const payload = ctx?.args;
        const text = Array.isArray(payload)
          ? payload.join(' ').trim()
          : String(payload?.text ?? payload?.message ?? payload?.value ?? payload ?? '').trim();
        if (!text) return { text: 'Usage: /crag-remember <text>' };
        const line = `- ${text}`;
        const existing = await fs.readFile(workspaceMemoryFile, 'utf8').catch(() => '');
        if (existing.split(/\r?\n/).some((l) => l.trim() === line)) {
          return { text: 'That memory is already saved.' };
        }
        const header = existing.trim() ? '\n' : '# Long-term Memory\n';
        await fs
          .writeFile(workspaceMemoryFile, `${header}${line}\n`, { flag: existing ? 'a' : 'w' } as any)
          .catch(async () => {
            const current = existing.trim() ? existing : '# Long-term Memory\n';
            await fs.writeFile(workspaceMemoryFile, `${current}${line}\n`);
          });
        await writeHealthState({ fallbackMemoryMirrorActive: true });
        return { text: 'Saved to MEMORY.md.' };
      } catch (error: any) {
        return { text: `Could not save memory: ${String(error?.message ?? error)}` };
      }
    },
  });

  const resolveCtxSession = (ctx: any) => {
    const sessionKey = String(
      ctx?.sessionKey ??
        ctx?.session?.key ??
        ctx?.session?.sessionKey ??
        ctx?.session_key ??
        ctx?.meta?.sessionKey ??
        ctx?.meta?.session_key ??
        ctx?.request?.sessionKey ??
        ctx?.request?.session_key ??
        '',
    ).trim();
    const directSessionId = String(
      ctx?.sessionId ??
        ctx?.session?.id ??
        ctx?.session?.sessionId ??
        ctx?.session_id ??
        ctx?.meta?.sessionId ??
        ctx?.meta?.session_id ??
        ctx?.request?.sessionId ??
        ctx?.request?.session_id ??
        '',
    ).trim();
    const mappedSessionId = sessionKey ? String(observedSessionIdsByKey.get(sessionKey) ?? '').trim() : '';
    let source: 'ctx' | 'mapped' | 'lastObserved' | 'missing' = 'missing';
    const sessionId = (() => {
      if (directSessionId) {
        source = 'ctx';
        return directSessionId;
      }
      if (mappedSessionId) {
        source = 'mapped';
        return mappedSessionId;
      }
      if (lastObservedSessionId) {
        source = 'lastObserved';
        return lastObservedSessionId;
      }
      return '';
    })();
    return { sessionKey, sessionId, source };
  };

  const parseSessionArg = (raw: string) => {
    const m = raw.match(/^\s*--session-id\s+([^\s]+)\s+([\s\S]+)$/i);
    if (!m) return { explicitSessionId: '', query: raw.trim() };
    return { explicitSessionId: String(m[1] ?? '').trim(), query: String(m[2] ?? '').trim() };
  };

  api.registerCommand?.({
    name: 'crag_recall',
    description:
      'Read-only recall with provenance from backend session memory and fallback mirrors. Usage: /crag_recall [--session-id <id>] <query>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const rawQueryInput = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const allSessions = /(?:^|\s)--all-sessions(?:\s|$)/i.test(rawQueryInput);
      const rawQuery = rawQueryInput.replace(/(?:^|\s)--all-sessions(?:\s|$)/gi, ' ').trim();
      const parsed = parseSessionArg(rawQuery);
      const explicitSessionId = parsed.explicitSessionId;
      const query = parsed.query;
      if (!query) return { text: 'Usage: /crag_recall [--session-id <id>] <query>' };
      const resolved = resolveCtxSession(ctx);
      const sessionKey = resolved.sessionKey;
      let sessionIdSource: 'explicit' | 'ctx' | 'mapped' | 'lastObserved' | 'missing' = 'missing';
      const sessionId = explicitSessionId
        ? ((sessionIdSource = 'explicit'), explicitSessionId)
        : ((sessionIdSource = resolved.source as any), resolved.sessionId);

      const backendHits = sessionId && !allSessions ? await collectBackendRecallHits(sessionId, query) : [];
      const localSessionIds = allSessions
        ? await listKnownSessionIds()
        : sessionId
          ? [sessionId]
          : [];
      const localHits: RecallHit[] = [];
      for (const localSessionId of localSessionIds) {
        const hits = await collectLocalRecallHits(localSessionId, query, true);
        for (const hit of hits) {
          localHits.push(hit);
          if (localHits.length >= 8) break;
        }
        if (localHits.length >= 8) break;
      }
      const mirrorHits = await collectMirrorRecallHits(query);
      const combined = [...backendHits, ...localHits, ...mirrorHits].slice(0, 8);
      const lines = [
        'CognitiveRAG Recall',
        `- query: ${query}`,
        `- all sessions: ${allSessions ? 'yes' : 'no'}`,
        `- sessionKey: ${sessionKey || 'unknown'}`,
        `- sessionId: ${sessionId || 'unknown'}`,
        `- sessionId source: ${sessionIdSource}`,
        `- backend hits: ${backendHits.length}`,
        `- local lossless hits: ${localHits.length}`,
        `- fallback mirror hits: ${mirrorHits.length}`,
      ];
      if (!combined.length) {
        lines.push('- hits: none');
      } else {
        lines.push('- hits:');
        for (const hit of combined) lines.push(`  - [${hit.source}] ${hit.text}`);
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_session_search',
    description:
      'Read-only local lossless session search. Usage: /crag_session_search [--session-id <id>] <query>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const parsed = parseSessionArg(raw);
      if (!parsed.query) return { text: 'Usage: /crag_session_search [--session-id <id>] <query>' };
      const resolved = resolveCtxSession(ctx);
      const sessionId = parsed.explicitSessionId || resolved.sessionId;
      if (!sessionId) return { text: 'No session id available yet. Provide --session-id <id>.' };
      const hits = await collectLocalRecallHits(sessionId, parsed.query, true);
      const lines = [
        'CognitiveRAG Local Session Search',
        `- query: ${parsed.query}`,
        `- sessionId: ${sessionId}`,
        `- hits: ${hits.length}`,
      ];
      for (const hit of hits) {
        lines.push(`  - [${hit.source}] ${hit.text}`);
      }
      if (!hits.length) lines.push('  - none');
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_session_describe',
    description:
      'Read-only local session-memory summary. Usage: /crag_session_describe [--session-id <id>] [query]',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const parsed = parseSessionArg(raw);
      const resolved = resolveCtxSession(ctx);
      const sessionId = parsed.explicitSessionId || resolved.sessionId;
      if (!sessionId) return { text: 'No session id available yet. Provide --session-id <id>.' };
      const entries = await readRawEntries(sessionId);
      const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
      const lines = [
        'CognitiveRAG Local Session Describe',
        `- sessionId: ${sessionId}`,
        `- raw entries: ${entries.length}`,
        `- compacted chunks: ${compact.items.length}`,
        `- fresh tail target: ${LOCAL_FRESH_TAIL_COUNT}`,
        `- compact chunk size: ${LOCAL_COMPACT_CHUNK_SIZE}`,
      ];
      if (parsed.query) {
        const hits = await collectLocalRecallHits(sessionId, parsed.query, true);
        lines.push(`- query: ${parsed.query}`);
        lines.push(`- query hits: ${hits.length}`);
      }
      if (compact.items.length) {
        lines.push('- compacted chunk ids:');
        for (const item of compact.items.slice(-6)) {
          lines.push(`  - ${item.chunkId} (${item.messageCount} msgs, seq ${item.startSeq}-${item.endSeq})`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_session_expand',
    description:
      'Read-only local session expansion by chunk id or seq. Usage: /crag_session_expand [--session-id <id>] <chunk-id|seq>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const parsed = parseSessionArg(raw);
      const target = parsed.query;
      if (!target) return { text: 'Usage: /crag_session_expand [--session-id <id>] <chunk-id|seq>' };
      const resolved = resolveCtxSession(ctx);
      const sessionId = parsed.explicitSessionId || resolved.sessionId;
      if (!sessionId) return { text: 'No session id available yet. Provide --session-id <id>.' };
      const entries = await readRawEntries(sessionId);
      const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
      let windowEntries: RawSessionEntry[] = [];
      const targetSeq = Number.parseInt(target, 10);
      if (Number.isFinite(targetSeq)) {
        windowEntries = entries.filter((entry) => entry.seq >= targetSeq - 3 && entry.seq <= targetSeq + 3);
      } else {
        const item = compact.items.find((it) => it.chunkId === target.trim());
        if (item) windowEntries = entries.filter((entry) => entry.seq >= item.startSeq && entry.seq <= item.endSeq);
      }
      const lines = [
        'CognitiveRAG Local Session Expand',
        `- sessionId: ${sessionId}`,
        `- target: ${target}`,
        `- expanded entries: ${windowEntries.length}`,
      ];
      if (!windowEntries.length) {
        lines.push('- no matching raw session material found');
      } else {
        lines.push('- entries:');
        for (const entry of windowEntries.slice(0, 20)) {
          const text = entry.text.replace(/\s+/g, ' ').trim();
          lines.push(`  - seq ${entry.seq} [${entry.sender}] ${text.length > 260 ? `${text.slice(0, 259)}…` : text}`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_session_export',
    description:
      'Read-only local session export snapshot. Usage: /crag_session_export [--session-id <id>] [snapshot-name]',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const parsed = parseSessionArg(raw);
      const resolved = resolveCtxSession(ctx);
      const sessionId = parsed.explicitSessionId || resolved.sessionId;
      if (!sessionId) return { text: 'No session id available yet. Provide --session-id <id>.' };
      await ensureSessionStoreDirs();
      const rawEntries = await readRawEntries(sessionId);
      const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
      const name = parsed.query ? toSafeSessionFilePart(parsed.query) : `snapshot-${Date.now()}`;
      const exportPath = path.join(sessionExportDir, `${toSafeSessionFilePart(sessionId)}-${name}.json`);
      const payload = {
        sessionId,
        exportedAt: new Date().toISOString(),
        rawEntryCount: rawEntries.length,
        compactChunkCount: compact.items.length,
        rawEntries,
        compact,
      };
      await fs.writeFile(exportPath, JSON.stringify(payload, null, 2));
      return {
        text: [
          'CognitiveRAG Session Export',
          `- sessionId: ${sessionId}`,
          `- raw entries: ${rawEntries.length}`,
          `- compacted chunks: ${compact.items.length}`,
          `- export path: ${exportPath}`,
        ].join('\n'),
      };
    },
  });

  api.registerCommand?.({
    name: 'crag_explain_memory',
    description: 'Read-only truth report of the active CognitiveRAG memory architecture.',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const current = await readHealthState();
      const slot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');
      const lines = [
        'CognitiveRAG Memory Architecture',
        `- active context engine slot: ${slot}`,
        '- cognitiverag-memory plugin loaded: yes',
        '- backend/session memory: used via /session_append_message, /session_upsert_context_item, /session_assemble_context',
        '- local lossless session layer: plugin-owned raw + compacted session store under session_memory/',
        `- fallback mirror MEMORY.md active: ${current?.fallbackMemoryMirrorActive ? 'yes' : 'no'}`,
        '- durable facts: selective promoted notes (exact facts) plus optional summaries',
        '- source truth:',
        '  - backend_session_memory: CRAG backend/session context',
        '  - lossless_session_raw: plugin-local exact message storage',
        '  - lossless_session_compact: plugin-local compacted history summaries with chunk ids',
        '  - fallback_mirror_plugin: plugin-local MEMORY.md',
        '  - fallback_mirror_workspace: workspace MEMORY.md',
      ];
      return { text: lines.join('\n') };
    },
  });

  // COMMAND: crag_status (read-only)
  // Invariants:
  // - runtime plugin must never create synthetic OpenClaw sessions or write transcripts
  // - runtime plugin must never depend on transcript/session-store writes
  // - status/health handlers must be read-only and must not trigger agent-lane executions
  api.registerCommand?.({
    name: 'crag_status',
    description: 'Show CognitiveRAG plugin/backend health and fallback status (read-only).',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      // Read-only status: do not create any session/transcript or call any agent CLI.
      const prior = await readHealthState();
      const probe = await probeBackend();
      const current = probe?.state ?? prior;
      const slot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');
      const lines = [
        'CognitiveRAG Status',
        `- contextEngine slot: ${slot}`,
        `- plugin loaded: yes`,
        `- backend reachable: ${current?.backendReachable ? 'yes' : 'no'}`,
        `- mode: ${current?.mode ?? 'unknown'}`,
        `- last success: ${current?.lastSuccessAt ?? 'never'}`,
        `- last failure: ${current?.lastFailAt ?? 'never'}`,
        `- last error: ${current?.lastError ?? 'none'}`,
        `- consecutive failures: ${current?.consecutiveFailures ?? 0}`,
        `- rollback recommended: ${current?.rollbackRecommended ? 'yes' : 'no'}`,
        `- rollback reason: ${current?.rollbackReason ?? 'none'}`,
        `- rollback ready: ${current?.rollbackReady ? 'yes' : 'no'}`,
        `- last rollback: ${current?.lastRollbackAt ?? 'never'}`,
        `- fallback memory mirror active: ${current?.fallbackMemoryMirrorActive ? 'yes' : 'no'}`,
      ];
      return { text: lines.join('\n') };
    },
  });

  api.registerContextEngine?.('cognitiverag-memory', () => ({
    info: {
      id: 'cognitiverag-memory',
      name: 'CognitiveRAG Memory Context Engine',
      version: '0.0.1',
      ownsCompaction: false,
    },

    async ingest(params: any) {
      const sessionId = String(params?.sessionId ?? 'unknown-session');
      const sessionKey = String(params?.sessionKey ?? '');
      rememberObservedSession(sessionKey, sessionId);
      const role = String(params?.message?.role ?? 'unknown');
      const text = extractTextContent(params?.message?.content);
      const turnId = `${Date.now()}`;
      const messageId = `${turnId}-${role}`;

      api.logger?.info?.('[cognitiverag-memory] ingest called', {
        sessionId,
        sessionKey,
        role,
      });

      try {
        const sender = role === 'assistant' ? 'assistant' : 'user';
        await appendRawSessionEntry(sessionId, sessionKey, messageId, role, sender, params?.message?.content);

        const msgRes = await postJson('/session_append_message', {
          session_id: sessionId,
          message_id: messageId,
          sender,
          text,
        });

        const partRes = text
          ? await postJson('/session_append_message_part', {
              session_id: sessionId,
              message_id: messageId,
              part_index: 0,
              text,
            })
          : null;

        const ctxRes = await postJson('/session_upsert_context_item', {
          item_id: `ctx-${messageId}`,
          session_id: sessionId,
          type: 'ingest',
          payload_json: {
            turn_id: turnId,
            role,
            session_key: params?.sessionKey ?? null,
            is_heartbeat: !!params?.isHeartbeat,
          },
        });

        const ok =
          msgRes.status === 200 &&
          (msgRes.body?.status === 'inserted' || msgRes.body?.status === 'updated');

        api.logger?.info?.(
          `[cognitiverag-memory] ingest forwarded ${JSON.stringify({
            sessionId,
            messageId,
            msgStatus: msgRes.status,
            msgBody: msgRes.body,
            partStatus: partRes?.status ?? null,
            partBody: partRes?.body ?? null,
            ctxStatus: ctxRes.status,
            ctxBody: ctxRes.body,
            ingested: ok,
          })}`,
        );

        if (ok) {
          await markSuccess();
          if (role === 'user' && text.trim()) {
            await promoteDurableFactToMirror(text, 'ingest');
          }
        } else await markFail('ingest_not_inserted');

        return { ingested: ok };
      } catch (error: any) {
        api.logger?.warn?.(
          `[cognitiverag-memory] ingest forward failed ${JSON.stringify({
            sessionId,
            error: String(error?.message ?? error),
          })}`,
        );
        await markFail(error);
        return { ingested: false };
      }
    },

    async assemble(params: any) {
      const sessionId = String(params?.sessionId ?? 'unknown-session');
      const sessionKey = String(params?.sessionKey ?? '');
      rememberObservedSession(sessionKey, sessionId);
      const inputMessages = Array.isArray(params?.messages) ? params.messages : [];
      api.logger?.info?.('[cognitiverag-memory] assemble called', {
        sessionId,
        sessionKey,
        inputMessages: inputMessages.length,
      });

      try {
        const budget = Number.isFinite(params?.tokenBudget)
          ? Math.max(256, Math.floor(params.tokenBudget))
          : 4096;
        const freshTailCount = 20;
        api.logger?.info?.(
          '[cognitiverag-memory] assemble input ' +
            JSON.stringify({
              sessionId,
              sessionKey: params?.sessionKey ?? null,
              inputMessagesCount: inputMessages.length,
              tokenBudget: budget,
              chosenFreshTailCount: freshTailCount,
            }),
        );

        const assemblyRes = await postJson('/session_assemble_context', {
          session_id: sessionId,
          fresh_tail_count: freshTailCount,
          budget,
        });
        api.logger?.info?.(
          '[cognitiverag-memory] assemble backend ' +
            JSON.stringify({
              sessionId,
              sessionKey: params?.sessionKey ?? null,
              assemblyStatus: assemblyRes?.status ?? null,
              bodyKeys:
                assemblyRes?.body && typeof assemblyRes.body === 'object'
                  ? Object.keys(assemblyRes.body)
                  : [],
              hasContextBlock: !!assemblyRes?.body?.context_block,
              exactItemsCount: Array.isArray(assemblyRes?.body?.context_block?.exact_items)
                ? assemblyRes.body.context_block.exact_items.length
                : 0,
              derivedItemsCount: Array.isArray(assemblyRes?.body?.context_block?.derived_items)
                ? assemblyRes.body.context_block.derived_items.length
                : 0,
              freshTailCountReturned: Array.isArray(assemblyRes?.body?.fresh_tail)
                ? assemblyRes.body.fresh_tail.length
                : 0,
              summariesCountReturned: Array.isArray(assemblyRes?.body?.summaries)
                ? assemblyRes.body.summaries.length
                : 0,
            }),
        );

        const shaped = shapeAssembleResponse(assemblyRes, budget);
        let { messages, systemPromptAddition, estimatedTokens, totalTokens } = shaped;
        try {
          const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
          if (Array.isArray(compact?.items) && compact.items.length) {
            const chunkLines = compact.items
              .slice(-4)
              .map((item) => `- ${item.chunkId} (seq ${item.startSeq}-${item.endSeq}): ${item.summary}`);
            const compactPrompt = [
              'Compacted session history (lossless local layer; expand via /crag_session_expand):',
              ...chunkLines,
            ].join('\n');
            systemPromptAddition = systemPromptAddition
              ? `${systemPromptAddition}\n\n${compactPrompt}`
              : compactPrompt;
          }
        } catch (e: any) {
          api.logger?.warn?.(
            `[cognitiverag-memory] local compaction read failed ${JSON.stringify({
              sessionId,
              error: String(e?.message ?? e),
            })}`,
          );
        }
        try {
          const fallback = await summarizeFallback({
            pluginMemoryPath: memoryFile,
            workspaceMemoryPath: workspaceMemoryFile,
            maxLines: 50,
            maxSummaryChars: 768,
            maxMessages: 8,
          });
          const fallbackSummary = String(fallback?.summary ?? '').trim();
          if ((Number(fallback?.sourceCounts?.plugin ?? 0) > 0 || Number(fallback?.sourceCounts?.workspace ?? 0) > 0) && !systemPromptAddition) {
            await writeHealthState({ fallbackMemoryMirrorActive: true });
          }
        if (fallbackSummary) {
          const fallbackPrompt = `Fallback memory mirror (durable user-noted facts):\n${fallbackSummary}`;
          systemPromptAddition = systemPromptAddition
            ? `${systemPromptAddition}\n\n${fallbackPrompt}`
            : fallbackPrompt;
        }
        const architecturePrompt =
          'Memory architecture truth: cognitiverag-memory is active. Backend/session memory is primary CRAG context; plugin-local lossless session layer stores exact + compacted history; MEMORY.md fallback mirror is auxiliary.';
        systemPromptAddition = systemPromptAddition
          ? `${systemPromptAddition}\n\n${architecturePrompt}`
          : architecturePrompt;
        } catch (e: any) {
          api.logger?.warn?.(
            `[cognitiverag-memory] fallback summarizer read failed ${JSON.stringify({
              sessionId,
              error: String(e?.message ?? e),
            })}`,
          );
        }

        api.logger?.info?.(
          '[cognitiverag-memory] assemble shaped ' +
            JSON.stringify({
              sessionId,
              sessionKey: params?.sessionKey ?? null,
              shapedMessagesCount: Array.isArray(messages) ? messages.length : 0,
              hasSystemPromptAddition: !!systemPromptAddition,
              systemPromptAdditionChars: (systemPromptAddition ?? '').length,
              shapedEstimatedTokens: estimatedTokens ?? null,
              shapedTotalTokens: totalTokens ?? null,
            }),
        );

        const boundedMessages = Array.isArray(messages) ? messages.slice(-20) : [];
        if (boundedMessages.length !== messages.length) {
          messages = boundedMessages;
          estimatedTokens = Math.max(
            0,
            messages.reduce((n: number, m: any) => n + Math.ceil(extractTextContent(m?.content).length / 4), 0) +
              Math.ceil((systemPromptAddition ?? '').length / 4),
          );
          totalTokens = estimatedTokens;
        }

        api.logger?.info?.(
          `[cognitiverag-memory] assemble forwarded ${JSON.stringify({
            sessionId,
            status: assemblyRes.status,
            freshTail: Array.isArray(assemblyRes?.body?.fresh_tail) ? assemblyRes.body.fresh_tail.length : 0,
            summaries: Array.isArray(assemblyRes?.body?.summaries) ? assemblyRes.body.summaries.length : 0,
            systemPromptAdditionChars: (systemPromptAddition ?? '').length,
            messages: messages.length,
            estimatedTokens,
            totalTokens,
          })}`,
        );

        if (assemblyRes.status >= 200 && assemblyRes.status < 300) await markSuccess();
        else await markFail(`assemble_status_${assemblyRes.status}`);

        return toEngineAssembleResult({
          ...shaped,
          systemPromptAddition,
        });
      } catch (error: any) {
        api.logger?.warn?.(
          `[cognitiverag-memory] assemble forward failed ${JSON.stringify({
            sessionId,
            error: String(error?.message ?? error),
          })}`,
        );
        api.logger?.warn?.(
          '[cognitiverag-memory] assemble error ' +
            JSON.stringify({
              sessionId,
              sessionKey: params?.sessionKey ?? null,
              error: String(error?.message ?? error),
            }),
        );
        await markFail(error);
        return toEngineAssembleResult({
          messages: inputMessages,
          estimatedTokens: 0,
          totalTokens: 0,
        });
      }
    },

    async compact(params: any) {
      api.logger?.info?.('[cognitiverag-memory] compact called', {
        sessionId: params?.sessionId,
        sessionKey: params?.sessionKey,
        force: !!params?.force,
      });
      const sessionId = String(params?.sessionId ?? '').trim();
      if (!sessionId) {
        return {
          ok: false,
          compacted: false,
          reason: 'missing_session_id',
        };
      }
      try {
        const compact = await rebuildCompaction(sessionId);
        return {
          ok: true,
          compacted: true,
          reason: 'rebuilt',
          rawEntries: compact.totalRawEntries,
          compactChunks: compact.items.length,
        };
      } catch (e: any) {
        return {
          ok: false,
          compacted: false,
          reason: String(e?.message ?? e),
        };
      }
    },
  }));

  const buildHealthPayload = async () => {
    const prior = await readHealthState();
    const probe = await probeBackend();
    const current = probe?.state ?? prior;
    return {
      pluginLoaded: true,
      contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
      backendReachable: !!current?.backendReachable,
      mode: current?.mode ?? 'unknown',
      lastSuccessAt: current?.lastSuccessAt ?? null,
      lastFailAt: current?.lastFailAt ?? null,
      lastError: current?.lastError ?? null,
      consecutiveFailures: Number(current?.consecutiveFailures ?? 0),
      fallbackMemoryMirrorActive: !!current?.fallbackMemoryMirrorActive,
      rollbackRecommended: !!current?.rollbackRecommended,
      rollbackReason: current?.rollbackReason ?? null,
      rollbackReady: !!current?.rollbackReady,
      lastRollbackAt: current?.lastRollbackAt ?? null,
    };
  };

  const respondHealthJson = async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const payload = await buildHealthPayload();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return true;
    } catch (e: any) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          pluginLoaded: true,
          contextEngineSlot: String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown'),
          backendReachable: false,
          mode: 'offline',
          lastSuccessAt: null,
          lastFailAt: new Date().toISOString(),
          lastError: String(e?.message ?? e),
          consecutiveFailures: 0,
          fallbackMemoryMirrorActive: false,
          rollbackRecommended: false,
          rollbackReason: String(e?.message ?? e),
          rollbackReady: true,
          lastRollbackAt: null,
        }),
      );
      return true;
    }
  };

  api.registerHttpRoute?.({
    path: '/cognitiverag-memory/status',
    auth: 'gateway',
    match: 'exact',
    handler: respondHealthJson,
  });

  api.registerHttpRoute?.({
    path: '/cognitiverag-memory/health',
    auth: 'gateway',
    match: 'exact',
    handler: respondHealthJson,
  });
}
