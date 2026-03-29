import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import { summarizeFallback } from './lib/fallbackMemorySummarizer.js';
import {
  detectNaturalAnswerIntent as detectNaturalIntentBridge,
  toBackendIntentFamily,
  type NaturalAnswerIntent as BridgeNaturalAnswerIntent,
} from './src/bridge/intentDetector.js';
import { fetchBackendAssembleContext } from './src/client/backendClient.js';
import { buildBackendSelectorPrompt } from './src/engine/assemble.js';
import { buildCragExplainMemoryText } from './src/commands/cragExplainMemory.js';
import { deriveOnlineLaneStatus, deriveSourceClasses } from './src/validators/contractValidator.js';

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
  onlineLaneStatus: 'enabled' | 'disabled' | 'unknown';
  onlineLaneLastCheckedAt: string | null;
  onlineLaneLastError: string | null;
  onlineSourceClasses: string[];
};

type RecallHit = {
  source:
    | 'backend_session_memory'
    | 'fallback_mirror_plugin'
    | 'fallback_mirror_workspace'
    | 'lossless_session_raw'
    | 'lossless_session_compact'
    | 'corpus_chunk'
    | 'large_file_excerpt'
    | 'web_evidence'
    | 'web_promoted_fact';
  text: string;
  sessionId?: string;
  chunkId?: string;
  corpusPath?: string;
  corpusTitle?: string;
  spanStart?: number;
  spanEnd?: number;
};

type RecallIntent = 'session' | 'corpus' | 'general';
type NaturalAnswerIntent = BridgeNaturalAnswerIntent;
type NaturalAnswerDraft = {
  intent: NaturalAnswerIntent;
  text: string;
  sourceBasis: string[];
};

type RankedRecallHit = {
  hit: RecallHit;
  score: number;
  reasons: string[];
};

type SessionQuoteHit = {
  source: 'lossless_session_raw' | 'lossless_session_compact';
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  score: number;
  exact: boolean;
  chunkId?: string;
  text: string;
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

type CorpusDoc = {
  docId: string;
  sourcePath: string;
  title: string;
  ingestedAt: string;
  charCount: number;
  chunkCount: number;
};

type CorpusChunk = {
  chunkId: string;
  docId: string;
  sourcePath: string;
  title: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  ingestedAt: string;
};

type CorpusStore = {
  version: 1;
  updatedAt: string;
  docs: CorpusDoc[];
  chunks: CorpusChunk[];
};

type LargeFileDoc = {
  docId: string;
  sourcePath: string;
  title: string;
  sizeBytes: number;
  ingestedAt: string;
  summary: string;
  excerptCount: number;
};

type LargeFileExcerpt = {
  excerptId: string;
  docId: string;
  sourcePath: string;
  title: string;
  excerptIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  ingestedAt: string;
};

type LargeFileStore = {
  version: 1;
  updatedAt: string;
  docs: LargeFileDoc[];
  excerpts: LargeFileExcerpt[];
};

const LOCAL_FRESH_TAIL_COUNT = 12;
const LOCAL_COMPACT_CHUNK_SIZE = 8;
const CORPUS_MAX_FILES_DEFAULT = 4;
const CORPUS_MAX_FILES_LIMIT = 12;
const CORPUS_MAX_FILE_BYTES = 512 * 1024;
const CORPUS_MIN_FILE_CHARS = 120;
const CORPUS_CHUNK_TARGET_CHARS = 900;
const CORPUS_CHUNK_OVERLAP_CHARS = 120;
const LARGE_FILE_THRESHOLD_BYTES = CORPUS_MAX_FILE_BYTES;
const LARGE_FILE_HARD_MAX_BYTES = 16 * 1024 * 1024;
const LARGE_FILE_EXCERPT_TARGET_CHARS = 1200;
const LARGE_FILE_EXCERPT_OVERLAP_CHARS = 180;
const LARGE_FILE_MAX_EXCERPTS_PER_DOC = 280;

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

function toHashId(input: string): string {
  return createHash('sha1').update(String(input ?? '')).digest('hex').slice(0, 16);
}

function deriveCorpusTitle(sourcePath: string, text: string): string {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 8 && line.length <= 160);
  if (firstLine) return firstLine;
  const base = path.basename(sourcePath);
  const withoutExt = base.replace(/\.[a-zA-Z0-9]+$/, '').trim();
  return withoutExt || base || 'Untitled Corpus Document';
}

function tokenizeQuery(input: string): string[] {
  return Array.from(
    new Set(
      String(input ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3),
    ),
  ).slice(0, 24);
}

const QUERY_STOPWORDS = new Set([
  'what',
  'can',
  'you',
  'tell',
  'about',
  'does',
  'the',
  'this',
  'that',
  'from',
  'with',
  'your',
  'into',
  'have',
  'has',
  'and',
  'for',
  'are',
  'use',
  'using',
  'say',
  'says',
  'said',
  'book',
  'books',
  'chapter',
  'chapters',
  'synopsis',
  'corpus',
  'memory',
  'remember',
  'remembering',
  'organized',
]);

function salientQueryTokens(input: string): string[] {
  return tokenizeQuery(input).filter((tok) => !QUERY_STOPWORDS.has(tok));
}

function extractCorpusTopicPhrase(query: string): string {
  const q = normalizeNaturalUserQuery(query).toLowerCase();
  if (!q) return '';
  const patterns = [
    /what can you tell me about\s+(.+?)\??$/i,
    /tell me about\s+(.+?)\??$/i,
    /what does\s+(.+?)\s+say\??$/i,
    /what does the synopsis say about\s+(.+?)\??$/i,
  ];
  for (const pattern of patterns) {
    const match = q.match(pattern);
    const phrase = String(match?.[1] ?? '').trim().replace(/[.?!]+$/g, '');
    if (!phrase) continue;
    if (/^(it|this|that|the book|the synopsis)$/i.test(phrase)) continue;
    return phrase;
  }
  if (q.includes('youtube secrets')) return 'youtube secrets';
  return '';
}

function normalizeNaturalUserQuery(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const filtered = lines.filter((line) => {
    if (line.startsWith('Sender (untrusted metadata):')) return false;
    if (line.startsWith('```')) return false;
    if (line === '{' || line === '}' || line.startsWith('"') || line.endsWith('{') || line.endsWith('}')) return false;
    if (/^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}/.test(line)) return true;
    return true;
  });
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const line = filtered[i];
    const m = line.match(/^\[[^\]]+\]\s*(.+)$/);
    const candidate = (m ? m[1] : line).trim();
    if (!candidate) continue;
    if (candidate === '{' || candidate === '}') continue;
    if (/^"[^"]*":/.test(candidate)) continue;
    return candidate;
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function detectRecallIntent(query: string): RecallIntent {
  const q = String(query ?? '').toLowerCase();
  if (!q) return 'general';
  const sessionSignals = [
    'session',
    'chat',
    'we said',
    'i said',
    'earlier',
    'previous message',
    'in this conversation',
  ];
  for (const signal of sessionSignals) {
    if (q.includes(signal)) return 'session';
  }
  const corpusSignals = [
    'what can you tell me about',
    'tell me about',
    'synopsis',
    'book',
    'chapter',
    'file',
    'excerpt',
    'quote',
    'source',
    'corpus',
    'document',
    'from ',
  ];
  for (const signal of corpusSignals) {
    if (q.includes(signal)) return 'corpus';
  }
  return 'general';
}

function detectNaturalAnswerIntent(query: string): NaturalAnswerIntent {
  return detectNaturalIntentBridge(query);
}

function looksLikeOpaqueToken(value: string): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /[A-Z0-9]{6,}[-_][A-Z0-9-]{4,}/.test(text) || /^[A-Z0-9_-]{18,}$/.test(text);
}

function sourceBaseWeight(source: RecallHit['source'], intent: RecallIntent): number {
  if (intent === 'session') {
    if (source === 'lossless_session_raw') return 100;
    if (source === 'lossless_session_compact') return 86;
    if (source === 'backend_session_memory') return 72;
    if (source === 'corpus_chunk') return 28;
    if (source === 'large_file_excerpt') return 24;
    return 16;
  }
  if (intent === 'corpus') {
    if (source === 'large_file_excerpt') return 102;
    if (source === 'corpus_chunk') return 92;
    if (source === 'backend_session_memory') return 46;
    if (source === 'lossless_session_raw') return 34;
    if (source === 'lossless_session_compact') return 30;
    return 20;
  }
  if (source === 'large_file_excerpt') return 80;
  if (source === 'corpus_chunk') return 74;
  if (source === 'backend_session_memory') return 63;
  if (source === 'lossless_session_raw') return 58;
  if (source === 'lossless_session_compact') return 52;
  return 28;
}

function rankRecallHits(query: string, hits: RecallHit[]): { ranked: RankedRecallHit[]; intent: RecallIntent } {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q || !Array.isArray(hits) || !hits.length) return { ranked: [], intent: detectRecallIntent(query) };
  const intent = detectRecallIntent(query);
  const qTokens = tokenizeQuery(q);
  const topicPhrase = extractCorpusTopicPhrase(q);
  const topicTokens = salientQueryTokens(topicPhrase || q);
  const nonMirrorPresent = hits.some(
    (hit) => hit?.source && hit.source !== 'fallback_mirror_plugin' && hit.source !== 'fallback_mirror_workspace',
  );
  const hasCorpusTopicAlignedCandidate =
    intent === 'corpus' &&
    topicTokens.length > 0 &&
    hits.some((hit) => {
      if (!hit || (hit.source !== 'corpus_chunk' && hit.source !== 'large_file_excerpt')) return false;
      const metaHay = `${String(hit.corpusTitle ?? '')}\n${String(hit.corpusPath ?? '')}`.toLowerCase();
      let overlap = 0;
      for (const tok of topicTokens) {
        if (metaHay.includes(tok)) overlap += 1;
      }
      return overlap >= Math.min(2, topicTokens.length);
    });
  const uniq = new Set<string>();
  const ranked: RankedRecallHit[] = [];

  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    const text = String(hit.text ?? '').trim();
    if (!text) continue;
    const dedupeKey = `${hit.source}|${hit.chunkId ?? ''}|${text.slice(0, 320)}`;
    if (uniq.has(dedupeKey)) continue;
    uniq.add(dedupeKey);

    const hay = text.toLowerCase();
    const reasons: string[] = [];
    let score = sourceBaseWeight(hit.source, intent);
    reasons.push(`source-weight:${score}`);

    const exact = hay.includes(q);
    if (exact) {
      score += 88;
      reasons.push('exact-query-match');
    }

    let overlap = 0;
    for (const tok of qTokens) {
      if (hay.includes(tok)) overlap += 1;
    }
    if (overlap > 0) {
      const overlapBoost = overlap * 7;
      score += overlapBoost;
      reasons.push(`token-overlap:${overlap}`);
    }

    if (hit.source === 'large_file_excerpt' && Number.isFinite(hit.spanStart) && Number.isFinite(hit.spanEnd)) {
      score += 14;
      reasons.push('has-span-provenance');
    } else if (hit.source === 'corpus_chunk' && hit.chunkId && hit.corpusPath) {
      score += 10;
      reasons.push('has-chunk-provenance');
    } else if (
      (hit.source === 'fallback_mirror_plugin' || hit.source === 'fallback_mirror_workspace') &&
      nonMirrorPresent
    ) {
      score -= 35;
      reasons.push('mirror-downgraded-better-sources-exist');
    }

    if (intent === 'session' && (hit.source === 'lossless_session_raw' || hit.source === 'lossless_session_compact')) {
      score += 20;
      reasons.push('session-intent-preference');
    }
    if (intent === 'corpus' && (hit.source === 'corpus_chunk' || hit.source === 'large_file_excerpt')) {
      score += 20;
      reasons.push('corpus-intent-preference');
      if (topicTokens.length > 0) {
        const metaHay = `${String(hit.corpusTitle ?? '')}\n${String(hit.corpusPath ?? '')}`.toLowerCase();
        let topicOverlap = 0;
        for (const tok of topicTokens) {
          if (metaHay.includes(tok)) topicOverlap += 1;
        }
        if (topicOverlap > 0) {
          const topicBoost = 48 + topicOverlap * 22;
          score += topicBoost;
          reasons.push(`topic-title-path-match:${topicOverlap}`);
        } else if (hasCorpusTopicAlignedCandidate) {
          score -= 95;
          reasons.push('topic-mismatch-penalty');
        }
        if (topicPhrase && metaHay.includes(topicPhrase)) {
          score += 34;
          reasons.push('topic-phrase-exact-meta-match');
        }
      }
    }

    ranked.push({ hit, score, reasons });
  }

  ranked.sort((a, b) => b.score - a.score || String(a.hit.source).localeCompare(String(b.hit.source)) || String(a.hit.text).localeCompare(String(b.hit.text)));
  return { ranked, intent };
}

function queryMatchesText(queryLower: string, textLower: string, qTokens: string[]): boolean {
  if (!queryLower || !textLower) return false;
  if (textLower.includes(queryLower)) return true;
  if (!qTokens.length) return false;
  let overlap = 0;
  for (const tok of qTokens) {
    if (textLower.includes(tok)) overlap += 1;
  }
  const minOverlap = qTokens.length >= 4 ? 2 : 1;
  return overlap >= minOverlap;
}

function buildSnippet(input: string, maxChars: number): string {
  const normalized = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function buildCorpusChunks(text: string): Array<{ startOffset: number; endOffset: number; text: string }> {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: Array<{ startOffset: number; endOffset: number; text: string }> = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    const target = Math.min(CORPUS_CHUNK_TARGET_CHARS, remaining);
    let end = cursor + target;
    if (end < normalized.length) {
      const lookBackStart = Math.max(cursor + Math.floor(target * 0.55), end - 220);
      const breakAtNewline = normalized.lastIndexOf('\n', end);
      const breakAtSentence = Math.max(
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf('! ', end),
        normalized.lastIndexOf('? ', end),
      );
      if (breakAtNewline >= lookBackStart) end = breakAtNewline + 1;
      else if (breakAtSentence >= lookBackStart) end = breakAtSentence + 2;
    }
    const snippet = normalized.slice(cursor, end).trim();
    if (snippet) {
      chunks.push({
        startOffset: cursor,
        endOffset: end,
        text: snippet,
      });
    }
    if (end >= normalized.length) break;
    cursor = Math.max(0, end - CORPUS_CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

function buildLargeFileExcerpts(text: string): Array<{ startOffset: number; endOffset: number; text: string }> {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: Array<{ startOffset: number; endOffset: number; text: string }> = [];
  let cursor = 0;
  while (cursor < normalized.length && chunks.length < LARGE_FILE_MAX_EXCERPTS_PER_DOC) {
    const remaining = normalized.length - cursor;
    const target = Math.min(LARGE_FILE_EXCERPT_TARGET_CHARS, remaining);
    let end = cursor + target;
    if (end < normalized.length) {
      const lookBackStart = Math.max(cursor + Math.floor(target * 0.5), end - 320);
      const breakAtNewline = normalized.lastIndexOf('\n', end);
      const breakAtSentence = Math.max(
        normalized.lastIndexOf('. ', end),
        normalized.lastIndexOf('! ', end),
        normalized.lastIndexOf('? ', end),
      );
      if (breakAtNewline >= lookBackStart) end = breakAtNewline + 1;
      else if (breakAtSentence >= lookBackStart) end = breakAtSentence + 2;
    }
    const snippet = normalized.slice(cursor, end).trim();
    if (snippet) {
      chunks.push({
        startOffset: cursor,
        endOffset: end,
        text: snippet,
      });
    }
    if (end >= normalized.length) break;
    cursor = Math.max(0, end - LARGE_FILE_EXCERPT_OVERLAP_CHARS);
  }
  return chunks;
}

function buildLargeFileSummary(sourcePath: string, text: string): string {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = lines.slice(0, 6).map((line) => (line.length > 150 ? `${line.slice(0, 149)}…` : line));
  const summaryLines = [
    `source: ${sourcePath}`,
    `lines: ${lines.length}`,
    `chars: ${normalized.length}`,
    'preview:',
    ...preview.map((line) => `- ${line}`),
  ];
  const summary = summaryLines.join('\n').trim();
  return summary.length > 1600 ? `${summary.slice(0, 1599)}…` : summary;
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
  onlineLaneStatus: 'unknown',
  onlineLaneLastCheckedAt: null,
  onlineLaneLastError: null,
  onlineSourceClasses: [],
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
  const sessionKeyMapFile = path.join(sessionMemoryDir, 'session_key_map.json');
  const corpusMemoryDir = path.join(pluginRoot, 'corpus_memory');
  const corpusIndexFile = path.join(corpusMemoryDir, 'corpus_index.json');
  const largeFileStoreDir = path.join(pluginRoot, 'large_file_store');
  const largeFileIndexFile = path.join(largeFileStoreDir, 'large_files.json');
  const bootstrappedSlot = String(api?.config?.plugins?.slots?.contextEngine ?? 'unknown');
  const observedSessionIdsByKey = new Map<string, string>();
  let lastObservedSessionId = '';

  try {
    if (fsSync.existsSync(sessionKeyMapFile)) {
      const raw = fsSync.readFileSync(sessionKeyMapFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const key = String(k ?? '').trim();
          const id = String(v ?? '').trim();
          if (!key || !id) continue;
          observedSessionIdsByKey.set(key, id);
          lastObservedSessionId = id;
        }
      }
    }
  } catch {
    // best-effort restore only
  }

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

  const probeOnlineLane = async () => {
    const now = new Date().toISOString();
    try {
      const webProbe = await fetchBackendAssembleContext(
        COG_RAG_BASE,
        {
          sessionId: '__crag_online_probe__',
          freshTailCount: 0,
          budget: 512,
          query: 'latest update verify source',
          intentFamily: 'investigative',
        },
        1500,
      );
      const onlineLaneStatus = deriveOnlineLaneStatus(webProbe.explanation);
      const sourceClasses = deriveSourceClasses(webProbe.explanation);
      await writeHealthState({
        onlineLaneStatus,
        onlineLaneLastCheckedAt: now,
        onlineLaneLastError: webProbe.explanation.ok ? null : webProbe.explanation.error,
        onlineSourceClasses: sourceClasses,
      });
      return {
        onlineLaneStatus,
        sourceClasses,
      };
    } catch (e: any) {
      await writeHealthState({
        onlineLaneStatus: 'unknown',
        onlineLaneLastCheckedAt: now,
        onlineLaneLastError: String(e?.message ?? e),
      });
      return {
        onlineLaneStatus: 'unknown' as const,
        sourceClasses: [] as string[],
      };
    }
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
        await probeOnlineLane();
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
    if (!key) return;
    observedSessionIdsByKey.set(key, id);
    void (async () => {
      try {
        await fs.mkdir(sessionMemoryDir, { recursive: true });
        const payload = Object.fromEntries(observedSessionIdsByKey.entries());
        await fs.writeFile(sessionKeyMapFile, JSON.stringify(payload, null, 2));
      } catch {
        // best-effort only
      }
    })();
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

  const ensureCorpusStoreDir = async () => {
    await fs.mkdir(corpusMemoryDir, { recursive: true });
  };

  const readCorpusStore = async (): Promise<CorpusStore> => {
    try {
      const raw = await fs.readFile(corpusIndexFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid corpus store');
      const docs = Array.isArray(parsed.docs) ? parsed.docs : [];
      const chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
      return {
        version: 1,
        updatedAt: String(parsed.updatedAt ?? new Date().toISOString()),
        docs: docs.filter((v: any) => v && typeof v === 'object') as CorpusDoc[],
        chunks: chunks.filter((v: any) => v && typeof v === 'object') as CorpusChunk[],
      };
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), docs: [], chunks: [] };
    }
  };

  const writeCorpusStore = async (store: CorpusStore) => {
    await ensureCorpusStoreDir();
    const next: CorpusStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      docs: Array.isArray(store?.docs) ? store.docs : [],
      chunks: Array.isArray(store?.chunks) ? store.chunks : [],
    };
    await fs.writeFile(corpusIndexFile, JSON.stringify(next, null, 2));
    return next;
  };

  const ensureLargeFileStoreDir = async () => {
    await fs.mkdir(largeFileStoreDir, { recursive: true });
  };

  const readLargeFileStore = async (): Promise<LargeFileStore> => {
    try {
      const raw = await fs.readFile(largeFileIndexFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid large file store');
      return {
        version: 1,
        updatedAt: String(parsed.updatedAt ?? new Date().toISOString()),
        docs: Array.isArray(parsed.docs) ? (parsed.docs as LargeFileDoc[]) : [],
        excerpts: Array.isArray(parsed.excerpts) ? (parsed.excerpts as LargeFileExcerpt[]) : [],
      };
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), docs: [], excerpts: [] };
    }
  };

  const writeLargeFileStore = async (store: LargeFileStore) => {
    await ensureLargeFileStoreDir();
    const next: LargeFileStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      docs: Array.isArray(store?.docs) ? store.docs : [],
      excerpts: Array.isArray(store?.excerpts) ? store.excerpts : [],
    };
    await fs.writeFile(largeFileIndexFile, JSON.stringify(next, null, 2));
    return next;
  };

  const upsertLargeFileDocument = async (sourcePath: string, content: string, sizeBytes: number) => {
    const normalized = String(content ?? '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return null;
    const docId = toHashId(`large:${sourcePath}`);
    const title = deriveCorpusTitle(sourcePath, normalized);
    const ingestedAt = new Date().toISOString();
    const excerpts = buildLargeFileExcerpts(normalized);
    const summary = buildLargeFileSummary(sourcePath, normalized);
    const store = await readLargeFileStore();
    const nextDocs = store.docs.filter((doc) => String(doc?.docId ?? '') !== docId);
    const nextExcerpts = store.excerpts.filter((entry) => String(entry?.docId ?? '') !== docId);
    nextDocs.push({
      docId,
      sourcePath,
      title,
      sizeBytes,
      ingestedAt,
      summary,
      excerptCount: excerpts.length,
    });
    excerpts.forEach((entry, idx) => {
      nextExcerpts.push({
        excerptId: `${docId}:${idx + 1}`,
        docId,
        sourcePath,
        title,
        excerptIndex: idx,
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        text: entry.text,
        ingestedAt,
      });
    });
    await writeLargeFileStore({
      version: 1,
      updatedAt: ingestedAt,
      docs: nextDocs.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
      excerpts: nextExcerpts,
    });
    return {
      docId,
      title,
      sourcePath,
      sizeBytes,
      summary,
      excerptCount: excerpts.length,
    };
  };

  const collectLargeFileRecallHits = async (query: string, limit = 8): Promise<RecallHit[]> => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const qTokens = tokenizeQuery(q);
    const store = await readLargeFileStore();
    const scored = store.excerpts
      .map((entry) => {
        const hay = String(entry?.text ?? '').toLowerCase();
        if (!hay) return null;
        const titleHay = String(entry?.title ?? '').toLowerCase();
        const pathHay = String(entry?.sourcePath ?? '').toLowerCase();
        const exactMatch = hay.includes(q) || titleHay.includes(q) || pathHay.includes(q);
        let score = 0;
        if (hay.includes(q)) score += 230;
        if (titleHay.includes(q)) score += 120;
        if (pathHay.includes(q)) score += 70;
        let overlap = 0;
        for (const tok of qTokens) {
          if (hay.includes(tok)) overlap += 1;
        }
        const minOverlap = qTokens.length >= 3 ? 2 : 1;
        if (!exactMatch && overlap < minOverlap) return null;
        score += overlap * 14;
        if (!exactMatch && score < 36) return null;
        return { entry, score };
      })
      .filter((row): row is { entry: LargeFileExcerpt; score: number } => !!row)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.entry.sourcePath.localeCompare(b.entry.sourcePath) ||
          a.entry.excerptIndex - b.entry.excerptIndex,
      )
      .slice(0, Math.max(1, limit));

    return scored.map(({ entry }) => {
      const compactText = entry.text.replace(/\s+/g, ' ').trim();
      const excerpt = compactText.length > 260 ? `${compactText.slice(0, 259)}…` : compactText;
      return {
        source: 'large_file_excerpt',
        chunkId: entry.excerptId,
        corpusPath: entry.sourcePath,
        corpusTitle: entry.title,
        spanStart: entry.startOffset,
        spanEnd: entry.endOffset,
        text: `${entry.title} | ${entry.sourcePath} | ${entry.excerptId} | span ${entry.startOffset}-${entry.endOffset} | ${excerpt}`,
      };
    });
  };

  const getLargeFileExcerptById = async (excerptId: string): Promise<LargeFileExcerpt | null> => {
    const id = String(excerptId ?? '').trim();
    if (!id) return null;
    const store = await readLargeFileStore();
    return store.excerpts.find((entry) => String(entry?.excerptId ?? '') === id) ?? null;
  };

  const collectCorpusFiles = async (rootDir: string, maxFiles: number): Promise<string[]> => {
    const root = path.resolve(rootDir);
    const allowedExt = new Set(['.txt', '.md', '.markdown']);
    const stack = [root];
    const files: string[] = [];
    const visited = new Set<string>();
    while (stack.length && files.length < maxFiles) {
      const dir = String(stack.pop() ?? '');
      if (!dir || visited.has(dir)) continue;
      visited.add(dir);
      let entries: any[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const dirs: string[] = [];
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const name = entry.name.toLowerCase();
          if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
          dirs.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!allowedExt.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const st = await fs.stat(abs);
          if (!Number.isFinite(st.size) || st.size > LARGE_FILE_HARD_MAX_BYTES || st.size < CORPUS_MIN_FILE_CHARS)
            continue;
          files.push(abs);
          if (files.length >= maxFiles) break;
        } catch {
          // best-effort only
        }
      }
      dirs.sort((a, b) => a.localeCompare(b));
      for (const next of dirs.reverse()) stack.push(next);
    }
    return files;
  };

  const upsertCorpusDocuments = async (filePaths: string[]) => {
    const store = await readCorpusStore();
    const now = new Date().toISOString();
    const dedupedPaths = Array.from(new Set(filePaths.map((p) => path.resolve(p))));
    const nextDocs = [...store.docs];
    const nextChunks = [...store.chunks];
    const ingested: Array<{ sourcePath: string; docId: string; title: string; chunkCount: number; charCount: number }> = [];
    const interceptedLarge: Array<{
      sourcePath: string;
      docId: string;
      title: string;
      sizeBytes: number;
      excerptCount: number;
      summary: string;
    }> = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];

    for (const sourcePath of dedupedPaths) {
      let text = '';
      let sizeBytes = 0;
      try {
        const stat = await fs.stat(sourcePath);
        sizeBytes = Number(stat?.size ?? 0);
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          skipped.push({ sourcePath, reason: 'too_large_or_invalid_size' });
          continue;
        }
        if (sizeBytes > LARGE_FILE_HARD_MAX_BYTES) {
          skipped.push({ sourcePath, reason: 'exceeds_large_file_hard_cap' });
          continue;
        }
        text = await fs.readFile(sourcePath, 'utf8');
      } catch (e: any) {
        skipped.push({ sourcePath, reason: `read_failed:${String(e?.message ?? e)}` });
        continue;
      }
      const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (normalized.length < CORPUS_MIN_FILE_CHARS) {
        skipped.push({ sourcePath, reason: 'too_short' });
        continue;
      }
      if (sizeBytes > LARGE_FILE_THRESHOLD_BYTES) {
        const upserted = await upsertLargeFileDocument(sourcePath, normalized, sizeBytes);
        if (!upserted) {
          skipped.push({ sourcePath, reason: 'large_file_upsert_failed' });
          continue;
        }
        interceptedLarge.push(upserted);
        continue;
      }
      const docId = toHashId(sourcePath);
      const title = deriveCorpusTitle(sourcePath, normalized);
      const chunkParts = buildCorpusChunks(normalized);
      if (!chunkParts.length) {
        skipped.push({ sourcePath, reason: 'no_chunks' });
        continue;
      }
      for (let i = nextDocs.length - 1; i >= 0; i -= 1) {
        if (String(nextDocs[i]?.docId ?? '') === docId) nextDocs.splice(i, 1);
      }
      for (let i = nextChunks.length - 1; i >= 0; i -= 1) {
        if (String(nextChunks[i]?.docId ?? '') === docId) nextChunks.splice(i, 1);
      }
      nextDocs.push({
        docId,
        sourcePath,
        title,
        ingestedAt: now,
        charCount: normalized.length,
        chunkCount: chunkParts.length,
      });
      chunkParts.forEach((part, idx) => {
        nextChunks.push({
          chunkId: `${docId}:${idx + 1}`,
          docId,
          sourcePath,
          title,
          chunkIndex: idx,
          startOffset: part.startOffset,
          endOffset: part.endOffset,
          text: part.text,
          ingestedAt: now,
        });
      });
      ingested.push({
        sourcePath,
        docId,
        title,
        chunkCount: chunkParts.length,
        charCount: normalized.length,
      });
    }

    const saved = await writeCorpusStore({
      version: 1,
      updatedAt: now,
      docs: nextDocs.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
      chunks: nextChunks,
    });
    return {
      ingested,
      interceptedLarge,
      skipped,
      totalDocs: saved.docs.length,
      totalChunks: saved.chunks.length,
      corpusIndexFile,
      largeFileIndexFile,
    };
  };

  const collectCorpusRecallHits = async (query: string, limit = 8): Promise<RecallHit[]> => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const qTokens = tokenizeQuery(q);
    const store = await readCorpusStore();
    const scored = store.chunks
      .map((chunk) => {
        const hay = String(chunk?.text ?? '').toLowerCase();
        if (!hay) return null;
        const titleHay = String(chunk?.title ?? '').toLowerCase();
        const pathHay = String(chunk?.sourcePath ?? '').toLowerCase();
        const exactMatch = hay.includes(q) || titleHay.includes(q) || pathHay.includes(q);
        let score = 0;
        if (hay.includes(q)) score += 200;
        if (titleHay.includes(q)) score += 90;
        if (pathHay.includes(q)) score += 60;
        let overlap = 0;
        for (const tok of qTokens) {
          if (hay.includes(tok)) overlap += 1;
        }
        const minOverlap = qTokens.length >= 3 ? 2 : 1;
        if (!exactMatch && overlap < minOverlap) return null;
        score += overlap * 12;
        if (!exactMatch && score < 30) return null;
        return { chunk, score };
      })
      .filter((entry): entry is { chunk: CorpusChunk; score: number } => !!entry)
      .sort((a, b) => b.score - a.score || a.chunk.sourcePath.localeCompare(b.chunk.sourcePath) || a.chunk.chunkIndex - b.chunk.chunkIndex)
      .slice(0, Math.max(1, limit));

    return scored.map(({ chunk }) => {
      const normalized = String(chunk.text ?? '').replace(/\s+/g, ' ').trim();
      const excerpt = normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
      return {
        source: 'corpus_chunk',
        chunkId: chunk.chunkId,
        corpusPath: chunk.sourcePath,
        corpusTitle: chunk.title,
        text: `${chunk.title} | ${chunk.sourcePath} | ${chunk.chunkId} | ${excerpt}`,
      };
    });
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
    const qTokens = tokenizeQuery(q);
    const rawEntries = await readRawEntries(sessionId);
    const hits: RecallHit[] = [];
    for (const entry of rawEntries) {
      const text = String(entry?.text ?? '').trim();
      if (!text) continue;
      if (!queryMatchesText(q, text.toLowerCase(), qTokens)) continue;
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
      if (!queryMatchesText(q, text.toLowerCase(), qTokens)) continue;
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

  const collectSessionQuoteHits = async (
    sessionId: string,
    query: string,
    exactMode: boolean,
    limit = 12,
  ): Promise<{
    raw: SessionQuoteHit[];
    compact: SessionQuoteHit[];
    expandedFromCompact: RawSessionEntry[];
  }> => {
    const q = String(query ?? '').trim().toLowerCase();
    if (!sessionId || !q) return { raw: [], compact: [], expandedFromCompact: [] };
    const qTokens = tokenizeQuery(q);
    const entries = await readRawEntries(sessionId);
    const compact = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));

    const rawHits: SessionQuoteHit[] = [];
    for (const entry of entries) {
      const text = String(entry?.text ?? '').trim();
      if (!text) continue;
      const hay = text.toLowerCase();
      const exact = hay.includes(q);
      if (exactMode && !exact) continue;
      if (!exactMode && !queryMatchesText(q, hay, qTokens)) continue;
      let overlap = 0;
      for (const tok of qTokens) {
        if (hay.includes(tok)) overlap += 1;
      }
      let score = exact ? 120 : 70;
      score += overlap * 8;
      rawHits.push({
        source: 'lossless_session_raw',
        sessionId,
        seqStart: entry.seq,
        seqEnd: entry.seq,
        score,
        exact,
        text: buildSnippet(text, 320),
      });
    }
    rawHits.sort((a, b) => b.score - a.score || a.seqStart - b.seqStart);

    const compactHits: SessionQuoteHit[] = [];
    for (const item of compact.items) {
      const text = `${item.summary}\n${item.sample.join('\n')}`;
      const hay = text.toLowerCase();
      const exact = hay.includes(q);
      if (exactMode && !exact) continue;
      if (!exactMode && !queryMatchesText(q, hay, qTokens)) continue;
      let overlap = 0;
      for (const tok of qTokens) {
        if (hay.includes(tok)) overlap += 1;
      }
      let score = exact ? 92 : 56;
      score += overlap * 6;
      compactHits.push({
        source: 'lossless_session_compact',
        sessionId,
        seqStart: item.startSeq,
        seqEnd: item.endSeq,
        chunkId: item.chunkId,
        score,
        exact,
        text: buildSnippet(item.summary, 320),
      });
    }
    compactHits.sort((a, b) => b.score - a.score || a.seqStart - b.seqStart);

    const expandedFromCompact = compactHits.length
      ? entries.filter((entry) => entry.seq >= compactHits[0].seqStart && entry.seq <= compactHits[0].seqEnd).slice(0, 24)
      : [];

    return {
      raw: rawHits.slice(0, Math.max(1, limit)),
      compact: compactHits.slice(0, Math.max(1, limit)),
      expandedFromCompact,
    };
  };

  const collectBackendRecallHits = async (sessionId: string, query: string): Promise<RecallHit[]> => {
    const trimmedQuery = String(query ?? '').trim().toLowerCase();
    if (!sessionId || !trimmedQuery) return [];
    const qTokens = tokenizeQuery(trimmedQuery);
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
        if (!queryMatchesText(trimmedQuery, normalized, qTokens)) continue;
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

  const latestUserQueryFromMessages = (messages: any[]): string => {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (String(msg?.role ?? '').toLowerCase() !== 'user') continue;
      const text = normalizeNaturalUserQuery(extractTextContent(msg?.content));
      if (text) return text;
    }
    return '';
  };

  const collectMemoryBullets = async (filePath: string): Promise<string[]> => {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('-'))
        .map((line) => line.replace(/^\-\s*/, '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const collectMirrorLinkedCorpusHits = async (query: string, limit = 4): Promise<RecallHit[]> => {
    const q = normalizeNaturalUserQuery(query).toLowerCase().trim();
    if (!q) return [];
    const qTokens = tokenizeQuery(q);
    const allBullets = [
      ...(await collectMemoryBullets(memoryFile)),
      ...(await collectMemoryBullets(workspaceMemoryFile)),
    ];
    const refs = allBullets
      .map((line) => {
        const sourceMatch = line.match(/SOURCE_PATH=([^;]+)(?:;|$)/i);
        const pointerMatch = line.match(/source path\s*`([^`]+)`/i);
        const sourcePath = String(sourceMatch?.[1] ?? pointerMatch?.[1] ?? '').trim();
        if (!sourcePath) return null;
        const titleMatch = line.match(/TITLE=([^;]+)(?:;|$)/i) ?? line.match(/corpus pointer:\s*([^,]+)/i);
        const title = String(titleMatch?.[1] ?? path.basename(sourcePath)).trim();
        return { sourcePath, title };
      })
      .filter((v): v is { sourcePath: string; title: string } => !!v);

    const seen = new Set<string>();
    const out: RecallHit[] = [];
    for (const ref of refs) {
      const key = `${ref.sourcePath}::${ref.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const titleHay = ref.title.toLowerCase();
      const pathHay = ref.sourcePath.toLowerCase();
      const titlePathMatch = queryMatchesText(q, `${titleHay}\n${pathHay}`, qTokens);
      let text = '';
      try {
        text = await fs.readFile(ref.sourcePath, 'utf8');
      } catch {
        continue;
      }
      const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (!body) continue;
      const bodyHay = body.toLowerCase();
      const bodyMatch = queryMatchesText(q, bodyHay, qTokens);
      if (!titlePathMatch && !bodyMatch) continue;
      const excerpt = buildSnippet(body, 340);
      out.push({
        source: 'corpus_chunk',
        chunkId: `mirror-path:${toHashId(ref.sourcePath).slice(0, 8)}`,
        corpusPath: ref.sourcePath,
        corpusTitle: ref.title,
        text: `${ref.title} | ${ref.sourcePath} | mirror-linked excerpt | ${excerpt}`,
      });
      if (out.length >= Math.max(1, limit)) break;
    }
    return out;
  };

  const collectPriorityMirrorTopicHits = async (query: string, limit = 2): Promise<RecallHit[]> => {
    const q = normalizeNaturalUserQuery(query).toLowerCase().trim();
    if (!q) return [];
    const topicPhrase = extractCorpusTopicPhrase(q);
    const topicTokens = salientQueryTokens(topicPhrase || q);
    if (!topicTokens.length) return [];
    const allBullets = [
      ...(await collectMemoryBullets(memoryFile)),
      ...(await collectMemoryBullets(workspaceMemoryFile)),
    ];
    const refs = allBullets
      .map((line) => {
        const sourceMatch = line.match(/SOURCE_PATH=([^;]+)(?:;|$)/i);
        const pointerMatch = line.match(/source path\s*`([^`]+)`/i);
        const sourcePath = String(sourceMatch?.[1] ?? pointerMatch?.[1] ?? '').trim();
        if (!sourcePath) return null;
        const titleMatch = line.match(/TITLE=([^;]+)(?:;|$)/i) ?? line.match(/corpus pointer:\s*([^,]+)/i);
        const title = String(titleMatch?.[1] ?? path.basename(sourcePath)).trim();
        return { sourcePath, title };
      })
      .filter((v): v is { sourcePath: string; title: string } => !!v);

    const seen = new Set<string>();
    const out: RecallHit[] = [];
    for (const ref of refs) {
      const key = `${ref.sourcePath}::${ref.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const metaHay = `${ref.title}\n${ref.sourcePath}`.toLowerCase();
      let overlap = 0;
      for (const tok of topicTokens) {
        if (metaHay.includes(tok)) overlap += 1;
      }
      if (overlap < Math.min(2, topicTokens.length)) continue;
      let text = '';
      try {
        text = await fs.readFile(ref.sourcePath, 'utf8');
      } catch {
        continue;
      }
      const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (!body) continue;
      const excerpt = buildSnippet(body, 420);
      out.push({
        source: 'corpus_chunk',
        chunkId: `mirror-priority:${toHashId(ref.sourcePath).slice(0, 8)}`,
        corpusPath: ref.sourcePath,
        corpusTitle: ref.title,
        text: `${ref.title} | ${ref.sourcePath} | mirror-priority excerpt | ${excerpt}`,
      });
      if (out.length >= Math.max(1, limit)) break;
    }
    return out;
  };

  const buildNaturalRoutingPrompt = async (sessionId: string, userQuery: string): Promise<string> => {
    const intent = detectNaturalAnswerIntent(userQuery);
    if (intent === 'none') return '';

      const lines: string[] = [`Natural answer routing intent: ${intent}`];
    const query = normalizeNaturalUserQuery(userQuery);

    if (intent === 'memory_summary') {
      const pluginBullets = await collectMemoryBullets(memoryFile);
      const workspaceBullets = await collectMemoryBullets(workspaceMemoryFile);
      const mergedBullets = Array.from(new Set([...pluginBullets, ...workspaceBullets]));
      const nonToken = mergedBullets.filter((line) => !looksLikeOpaqueToken(line));
      const tokenCount = mergedBullets.length - nonToken.length;
      const compacted = (await readCompactStore(sessionId)) ?? (await rebuildCompaction(sessionId));
      const rawEntries = await readRawEntries(sessionId);
      const corpusStore = await readCorpusStore();
      const largeStore = await readLargeFileStore();
      const titles = Array.from(
        new Set(
          [...corpusStore.docs.map((d) => d.title), ...largeStore.docs.map((d) => d.title)]
            .map((t) => String(t ?? '').trim())
            .filter(Boolean),
        ),
      ).slice(0, 4);

      lines.push('Auto memory summary evidence:');
      lines.push(`- durable notes (non-token): ${nonToken.length}`);
      if (tokenCount > 0) lines.push(`- opaque token facts available on request: ${tokenCount}`);
      nonToken.slice(0, 4).forEach((line) => lines.push(`- durable highlight: ${buildSnippet(line, 140)}`));
      lines.push(`- session raw entries: ${rawEntries.length}`);
      lines.push(`- session compacted chunks: ${compacted.items.length}`);
      if (titles.length) {
        lines.push('- known corpus/book titles:');
        titles.forEach((t) => lines.push(`  - ${buildSnippet(t, 100)}`));
      }
      lines.push(
        'Answer contract: provide a layered summary (profile/preferences, durable facts, recent session context, corpus/books). Do not dump raw token lists unless user explicitly asks for exact tokens.',
      );
      const recentMeaningful = rawEntries
        .map((entry) => buildSnippet(entry.text, 160))
        .filter((line) => line && !looksLikeOpaqueToken(line) && !line.toLowerCase().includes('sender (untrusted metadata)'))
        .slice(-4);
      if (recentMeaningful.length) {
        lines.push('- recent meaningful session snippets:');
        recentMeaningful.forEach((line) => lines.push(`  - ${line}`));
      }
      lines.push('Answer quality rule: include at most 2 opaque token examples in normal summaries, and prioritize meaningful facts over storage internals.');
      lines.push('Hard format rule: use exactly 6 sections titled Memory stack in use (primary -> supporting), About you, Recent durable facts, Current conversation context, Books/corpus I can draw from, and What I am still missing.');
    } else if (intent === 'architecture') {
      lines.push('Auto architecture truth contract:');
      lines.push('- cognitiverag-memory is active context engine when slot says so.');
      lines.push('- distinguish backend/session CRAG memory vs lossless local session layer vs fallback MEMORY.md mirror vs corpus/large-file retrieval.');
      lines.push('- for current answer, include a short source-basis sentence.');
    } else if (intent === 'corpus') {
      const largeHits = await collectLargeFileRecallHits(query, 4);
      const corpusHits = await collectCorpusRecallHits(query, 4);
      const mirrorLinkedHits = await collectMirrorLinkedCorpusHits(query, 3);
      const { ranked } = rankRecallHits(query, [...largeHits, ...corpusHits, ...mirrorLinkedHits]);
      lines.push('Auto corpus evidence:');
      lines.push(`- large-file hits: ${largeHits.length}`);
      lines.push(`- corpus chunk hits: ${corpusHits.length}`);
      lines.push(`- mirror-linked corpus hits: ${mirrorLinkedHits.length}`);
      ranked.slice(0, 4).forEach((item) => {
        const pathPart = item.hit.corpusPath ? ` | ${item.hit.corpusPath}` : '';
        const chunkPart = item.hit.chunkId ? ` | ${item.hit.chunkId}` : '';
        const spanPart =
          Number.isFinite(item.hit.spanStart) && Number.isFinite(item.hit.spanEnd)
            ? ` | span ${item.hit.spanStart}-${item.hit.spanEnd}`
            : '';
        lines.push(
          `- ${item.hit.source}${pathPart}${chunkPart}${spanPart} | score=${item.score} | ${buildSnippet(item.hit.text, 170)}`,
        );
      });
      lines.push(
        'Answer contract: if corpus evidence exists, answer from retrieved excerpts and cite source path/chunk/span. If only metadata exists, state that honestly.',
      );
      const top = ranked[0]?.hit;
      if (top) {
        lines.push(
          `Top corpus evidence to use now: ${top.source} | ${top.corpusTitle ?? 'unknown-title'} | ${top.corpusPath ?? 'unknown-path'} | ${
            top.chunkId ?? 'no-chunk'
          } | ${buildSnippet(top.text, 220)}`,
        );
      }
      lines.push('Do not claim corpus content is unavailable when auto corpus evidence contains excerpt hits.');
    } else if (intent === 'chat_recall') {
      const quote = await collectSessionQuoteHits(sessionId, query, false, 6);
      lines.push('Auto session recall evidence:');
      lines.push(`- raw quote hits: ${quote.raw.length}`);
      lines.push(`- compact quote hits: ${quote.compact.length}`);
      quote.raw.slice(0, 4).forEach((hit) => {
        lines.push(`- raw seq ${hit.seqStart}-${hit.seqEnd} score=${hit.score} exact=${hit.exact ? 'yes' : 'no'} ${hit.text}`);
      });
      quote.compact.slice(0, 2).forEach((hit) => {
        lines.push(`- compact ${hit.chunkId} seq ${hit.seqStart}-${hit.seqEnd} score=${hit.score}`);
      });
      lines.push('Answer contract: answer naturally, and include source basis (session raw vs compact) when recall confidence depends on it.');
    }

    const prompt = lines.join('\n').trim();
    if (!prompt) return '';
    return prompt.length > 2600 ? `${prompt.slice(0, 2599)}…` : prompt;
  };

  const buildNaturalAnswerDraft = async (sessionId: string, userQuery: string): Promise<NaturalAnswerDraft | null> => {
    const intent = detectNaturalAnswerIntent(userQuery);
    if (intent === 'none') return null;
    const query = normalizeNaturalUserQuery(userQuery);

    const short = (input: string, max = 1700) => {
      const text = String(input ?? '').replace(/\s+\n/g, '\n').trim();
      if (text.length <= max) return text;
      return `${text.slice(0, max - 1)}…`;
    };

    const buildCorpusEffectiveQuery = async (sid: string, q: string): Promise<string> => {
      const normalized = normalizeNaturalUserQuery(q);
      const topic = extractCorpusTopicPhrase(normalized);
      if (topic) return normalized;
      if (!/\bsynopsis\b/i.test(normalized)) return normalized;
      const entries = await readRawEntries(sid);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (String(entry?.sender ?? '') !== 'user') continue;
        const text = normalizeNaturalUserQuery(String(entry?.text ?? ''));
        if (!text || text.toLowerCase() === normalized.toLowerCase()) continue;
        const found = extractCorpusTopicPhrase(text);
        if (found) return `${normalized} ${found}`.trim();
      }
      return normalized;
    };

    if (intent === 'memory_summary') {
      const mirrorBullets = Array.from(
        new Set([...(await collectMemoryBullets(memoryFile)), ...(await collectMemoryBullets(workspaceMemoryFile))]),
      );
      const nonToken = mirrorBullets.filter((line) => !looksLikeOpaqueToken(line));
      const tokenCount = Math.max(0, mirrorBullets.length - nonToken.length);
      const rawEntries = await readRawEntries(sessionId);
      const recentSession = rawEntries
        .map((entry) => buildSnippet(entry.text, 170))
        .filter((line) => line && !looksLikeOpaqueToken(line) && !line.toLowerCase().includes('sender (untrusted metadata)'))
        .slice(-4);
      const profile = nonToken
        .filter((line) => /(prefer|preference|like|goal|focus|workflow|project|stack|automation|schedule)/i.test(line))
        .slice(0, 3);
      const durable = nonToken.filter((line) => !profile.includes(line)).slice(0, 4);
      const corpusStore = await readCorpusStore();
      const largeStore = await readLargeFileStore();
      const titles = Array.from(
        new Set(
          [...corpusStore.docs.map((d) => d.title), ...largeStore.docs.map((d) => d.title)]
            .map((t) => String(t ?? '').trim())
            .filter(Boolean),
        ),
      ).slice(0, 4);
      const text = [
        'Memory stack in use (primary -> supporting):',
        '- Active context engine: cognitiverag-memory (primary).',
        '- Backend/session memory: primary turn-by-turn CRAG context.',
        '- Local lossless session memory: raw + compacted history for recall/quote/expand.',
        '- Corpus + large-file memory: excerpt retrieval with provenance for books/files.',
        '- Markdown mirrors (MEMORY.md + daily notes): fallback/user-facing summaries, not the full memory system.',
        '',
        'About you:',
        ...(profile.length
          ? profile.map((line) => `- ${buildSnippet(line, 180)}`)
          : ['- No strong personal profile/preferences captured yet.']),
        '',
        'Recent durable facts:',
        ...(durable.length
          ? durable.map((line) => `- ${buildSnippet(line, 180)}`)
          : ['- Durable memory exists, but most entries are still token-like and need curation.']),
        ...(tokenCount > 0 ? [`- Opaque token entries available on request: ${tokenCount}`] : []),
        '',
        'Current conversation context:',
        ...(recentSession.length ? recentSession.map((line) => `- ${line}`) : ['- No rich recent session snippets available yet.']),
        '',
        'Books/corpus I can draw from:',
        ...(titles.length ? titles.map((t) => `- ${buildSnippet(t, 140)}`) : ['- No indexed corpus/book titles found.']),
        '',
        'What I am still missing:',
        '- Your preferred name/pronouns/timezone in USER.md (if you want these remembered).',
        '- More human-meaningful durable notes; current mirror still has many opaque validation tokens.',
      ].join('\n');
      return {
        intent,
        text: short(text),
        sourceBasis: [
          'active context-engine + backend/session memory',
          'local lossless session memory (raw + compacted)',
          titles.length ? 'corpus/large-file index + excerpts' : 'no indexed corpus titles',
          'markdown mirrors (fallback summaries)',
        ],
      };
    }

    if (intent === 'architecture') {
      const text = [
        'Yes. CRAG/lossless memory is active.',
        '',
        'Memory layers (primary -> supporting):',
        '- cognitiverag-memory context engine (active, primary orchestrator).',
        '- backend/session CRAG memory (primary turn context).',
        '- local lossless session memory (raw + compacted history for recall/quote/expand).',
        '- corpus + large-file retrieval (book/file excerpts with provenance).',
        '- MEMORY.md and daily notes (fallback/user-facing mirrors only).',
        '',
        'Mirror files help with human-readable continuity, but they are not the whole memory system.',
      ].join('\n');
      return {
        intent,
        text,
        sourceBasis: ['runtime architecture contract (layered memory truth model)'],
      };
    }

    if (intent === 'corpus') {
      const effectiveQuery = await buildCorpusEffectiveQuery(sessionId, query);
      const mirrorPriorityHits = await collectPriorityMirrorTopicHits(effectiveQuery, 2);
      const largeHits = await collectLargeFileRecallHits(effectiveQuery, 5);
      const corpusHits = await collectCorpusRecallHits(effectiveQuery, 5);
      const mirrorLinkedHits = await collectMirrorLinkedCorpusHits(effectiveQuery, 5);
      const { ranked } = rankRecallHits(effectiveQuery, [
        ...mirrorPriorityHits,
        ...largeHits,
        ...corpusHits,
        ...mirrorLinkedHits,
      ]);
      if (!ranked.length) {
        return {
          intent,
          text: 'No matched corpus excerpt is currently available for this query; only metadata-level memory is visible.',
          sourceBasis: ['corpus retrieval returned no excerpt hits'],
        };
      }
      const picks = ranked.slice(0, 2);
      const lines = ['Retrieved corpus evidence:'];
      for (const entry of picks) {
        const hit = entry.hit;
        const label = hit.corpusTitle || hit.corpusPath || hit.source;
        const prov = [hit.chunkId ?? '', Number.isFinite(hit.spanStart) ? `span ${hit.spanStart}-${hit.spanEnd}` : '']
          .filter(Boolean)
          .join(' | ');
        lines.push(`- ${buildSnippet(label, 180)}${hit.corpusPath ? ` (${hit.corpusPath})` : ''}`);
        lines.push(`  excerpt: ${buildSnippet(hit.text, 260)}`);
        if (prov) lines.push(`  provenance: ${prov}`);
      }
      return {
        intent,
        text: short(lines.join('\n')),
        sourceBasis: [
          ...picks.map((entry) => `${entry.hit.source}${entry.hit.corpusPath ? `:${entry.hit.corpusPath}` : ''}`),
          mirrorPriorityHits.length ? `mirror-priority-hits:${mirrorPriorityHits.length}` : '',
          effectiveQuery !== query ? `effective-query:${effectiveQuery}` : '',
        ].filter(Boolean),
      };
    }

    if (intent === 'chat_recall') {
      const quote = await collectSessionQuoteHits(sessionId, query, false, 6);
      const rawHits = quote.raw.slice(0, 2);
      const compactHits = quote.compact.slice(0, 1);
      const lines = ['Recovered prior chat evidence:'];
      if (rawHits.length) {
        rawHits.forEach((hit) => lines.push(`- raw seq ${hit.seqStart}-${hit.seqEnd}: ${buildSnippet(hit.text, 260)}`));
      } else if (compactHits.length) {
        compactHits.forEach((hit) =>
          lines.push(`- compact ${hit.chunkId} seq ${hit.seqStart}-${hit.seqEnd}: ${buildSnippet(hit.text, 240)}`),
        );
      } else {
        lines.push('- No high-confidence earlier chat match found.');
      }
      return {
        intent,
        text: short(lines.join('\n')),
        sourceBasis: rawHits.length ? ['lossless_session_raw'] : compactHits.length ? ['lossless_session_compact'] : ['no-session-hit'],
      };
    }

    return null;
  };

  const isTokenHeavyAssistantText = (text: string): boolean => {
    const normalized = String(text ?? '');
    if (!normalized.trim()) return false;
    const tokenish = normalized.match(/`[A-Z0-9][A-Z0-9_-]{8,}`/g) ?? [];
    if (tokenish.length >= 4) return true;
    if (/I remember these durable items/i.test(normalized) && tokenish.length >= 2) return true;
    return false;
  };

  const pruneMessagesForDeterministicIntent = (messages: any[], intent: NaturalAnswerIntent): any[] => {
    if (!Array.isArray(messages) || !messages.length) return [];
    if (intent !== 'memory_summary' && intent !== 'corpus' && intent !== 'architecture') return messages;
    const out: any[] = [];
    for (const msg of messages) {
      const role = String(msg?.role ?? '').toLowerCase();
      if (role !== 'assistant') {
        out.push(msg);
        continue;
      }
      const text = extractTextContent(msg?.content);
      if (intent === 'memory_summary' && isTokenHeavyAssistantText(text)) continue;
      if (
        intent === 'corpus' &&
        (/Only the title-level memory:/i.test(text) ||
          /I don.?t have (deeper|richer) content/i.test(text) ||
          /title\/path-level/i.test(text))
      ) {
        continue;
      }
      if (
        intent === 'architecture' &&
        (/I (?:only )?use the workspace memory system/i.test(text) ||
          /there is no cognitiverag plugin/i.test(text))
      ) {
        continue;
      }
      out.push(msg);
    }
    return out;
  };

  const enforceDeterministicDraftOnLastUser = (
    messages: any[],
    intent: NaturalAnswerIntent,
    query: string,
    draft: NaturalAnswerDraft | null,
  ): any[] => {
    if (!Array.isArray(messages) || !messages.length || !draft) return messages;
    if (intent !== 'memory_summary' && intent !== 'corpus' && intent !== 'architecture') return messages;
    const out = [...messages];
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const role = String(out[i]?.role ?? '').toLowerCase();
      if (role !== 'user') continue;
      const modeLabel =
        intent === 'memory_summary' ? 'memory_summary' : intent === 'corpus' ? 'corpus_overview' : 'architecture_overview';
      const strictPrompt = [
        `DETERMINISTIC_RESPONSE_MODE=${modeLabel}`,
        `Original user question: ${normalizeNaturalUserQuery(query)}`,
        'You must answer with the exact drafted response below.',
        'Do not add or remove sections.',
        'Do not replace with metadata-only fallback if drafted response contains retrieved excerpts.',
        '',
        'BEGIN_DRAFT_RESPONSE',
        String(draft.text ?? '').trim(),
        'END_DRAFT_RESPONSE',
      ].join('\n');
      out[i] = {
        ...out[i],
        content: toContentBlocks(strictPrompt),
      };
      return out;
    }
    return out;
  };

  const buildHardDeterministicMessages = (
    intent: NaturalAnswerIntent,
    query: string,
    draft: NaturalAnswerDraft,
  ): any[] => {
    if (intent !== 'memory_summary' && intent !== 'corpus' && intent !== 'architecture') return [];
    const modeLabel =
      intent === 'memory_summary' ? 'memory_summary' : intent === 'corpus' ? 'corpus_overview' : 'architecture_overview';
    const sourceSummary = Array.isArray(draft.sourceBasis) && draft.sourceBasis.length
      ? draft.sourceBasis.map((line) => `- ${line}`).join('\n')
      : '- unknown';
    const systemText = [
      `HARD_SHORT_CIRCUIT_INTENT=${modeLabel}`,
      'Deterministic response mode is mandatory for this turn.',
      'Ignore any earlier assistant style and do not revert to token/file dumps.',
      'Return only the exact final answer between BEGIN_FINAL_ANSWER and END_FINAL_ANSWER.',
      'Do not add prefaces, disclaimers, or extra sections.',
    ].join('\n');
    const userText = [
      `Original user question: ${normalizeNaturalUserQuery(query)}`,
      'Use this evidence basis:',
      sourceSummary,
      '',
      'BEGIN_FINAL_ANSWER',
      String(draft.text ?? '').trim(),
      'END_FINAL_ANSWER',
    ].join('\n');
    return [
      {
        role: 'system',
        content: toContentBlocks(systemText),
      },
      {
        role: 'user',
        content: toContentBlocks(userText),
      },
    ];
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

  const parseCorpusIngestArgs = (rawInput: string) => {
    const raw = String(rawInput ?? '');
    const parsed = {
      root: '/mnt/g/@Cursuri',
      maxFiles: CORPUS_MAX_FILES_DEFAULT,
      files: [] as string[],
    };
    const applyOpt = (re: RegExp, onValue: (value: string) => void) => {
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(raw))) {
        const value = String(m[1] ?? m[2] ?? m[3] ?? '').trim();
        if (value) onValue(value);
      }
    };
    applyOpt(/--root\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi, (value) => {
      parsed.root = value;
    });
    applyOpt(/--max-files\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi, (value) => {
      const num = Number.parseInt(value, 10);
      if (Number.isFinite(num) && num > 0) parsed.maxFiles = Math.min(CORPUS_MAX_FILES_LIMIT, Math.max(1, num));
    });
    applyOpt(/--file\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi, (value) => {
      parsed.files.push(path.resolve(value));
    });
    parsed.files = Array.from(new Set(parsed.files));
    return parsed;
  };

  api.registerCommand?.({
    name: 'crag_corpus_ingest',
    description:
      'Ingest a bounded corpus subset into plugin-local chunked storage with provenance. Usage: /crag_corpus_ingest [--root <path>] [--max-files <n>] [--file <path>]...',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const parsed = parseCorpusIngestArgs(raw);
      const maxFiles = Math.min(CORPUS_MAX_FILES_LIMIT, Math.max(1, Number(parsed.maxFiles ?? CORPUS_MAX_FILES_DEFAULT)));
      const sourceFiles = parsed.files.length ? parsed.files : await collectCorpusFiles(parsed.root, maxFiles);
      if (!sourceFiles.length) {
        return {
          text: [
            'CognitiveRAG Corpus Ingest',
            `- root: ${parsed.root}`,
            `- max files: ${maxFiles}`,
            '- selected files: 0',
            '- result: no eligible files found',
          ].join('\n'),
        };
      }
      const selected = sourceFiles.slice(0, maxFiles);
      const result = await upsertCorpusDocuments(selected);
      const lines = [
        'CognitiveRAG Corpus Ingest',
        `- root: ${parsed.root}`,
        `- max files: ${maxFiles}`,
        `- selected files: ${selected.length}`,
        `- ingested files: ${result.ingested.length}`,
        `- intercepted large files: ${result.interceptedLarge.length}`,
        `- skipped files: ${result.skipped.length}`,
        `- total corpus docs: ${result.totalDocs}`,
        `- total corpus chunks: ${result.totalChunks}`,
        `- corpus index: ${result.corpusIndexFile}`,
        `- large file index: ${result.largeFileIndexFile}`,
      ];
      if (result.ingested.length) {
        lines.push('- ingested:');
        for (const doc of result.ingested.slice(0, 8)) {
          lines.push(`  - ${doc.title} | ${doc.sourcePath} | chunks=${doc.chunkCount} | chars=${doc.charCount}`);
        }
      }
      if (result.interceptedLarge.length) {
        lines.push('- intercepted large files:');
        for (const doc of result.interceptedLarge.slice(0, 8)) {
          lines.push(
            `  - ${doc.title} | ${doc.sourcePath} | bytes=${doc.sizeBytes} | excerpts=${doc.excerptCount}`,
          );
        }
      }
      if (result.skipped.length) {
        lines.push('- skipped:');
        for (const skip of result.skipped.slice(0, 8)) {
          lines.push(`  - ${skip.sourcePath} | ${skip.reason}`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_corpus_search',
    description: 'Read-only corpus chunk retrieval with provenance. Usage: /crag_corpus_search <query>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const query = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      if (!query) return { text: 'Usage: /crag_corpus_search <query>' };
      const hits = await collectCorpusRecallHits(query, 8);
      const lines = [
        'CognitiveRAG Corpus Search',
        `- query: ${query}`,
        `- hits: ${hits.length}`,
      ];
      if (!hits.length) {
        lines.push('- no matching corpus chunks');
      } else {
        lines.push('- matches:');
        for (const hit of hits) {
          lines.push(`  - [${hit.source}] ${hit.text}`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_corpus_describe',
    description: 'Read-only corpus index summary with provenance coverage.',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const store = await readCorpusStore();
      const lines = [
        'CognitiveRAG Corpus Describe',
        `- docs: ${store.docs.length}`,
        `- chunks: ${store.chunks.length}`,
        `- updated: ${store.updatedAt}`,
        `- corpus index: ${corpusIndexFile}`,
      ];
      if (store.docs.length) {
        lines.push('- docs:');
        for (const doc of store.docs.slice(0, 8)) {
          lines.push(`  - ${doc.title} | ${doc.sourcePath} | chunks=${doc.chunkCount}`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_large_describe',
    description: 'Read-only large-file store summary and exploration metadata.',
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      const store = await readLargeFileStore();
      const lines = [
        'CognitiveRAG Large File Store Describe',
        `- threshold bytes: ${LARGE_FILE_THRESHOLD_BYTES}`,
        `- hard cap bytes: ${LARGE_FILE_HARD_MAX_BYTES}`,
        `- docs: ${store.docs.length}`,
        `- excerpts: ${store.excerpts.length}`,
        `- updated: ${store.updatedAt}`,
        `- large file index: ${largeFileIndexFile}`,
      ];
      if (store.docs.length) {
        lines.push('- docs:');
        for (const doc of store.docs.slice(0, 8)) {
          lines.push(`  - ${doc.title} | ${doc.sourcePath} | bytes=${doc.sizeBytes} | excerpts=${doc.excerptCount}`);
        }
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_large_search',
    description: 'Read-only large-file excerpt search with provenance. Usage: /crag_large_search <query>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const query = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      if (!query) return { text: 'Usage: /crag_large_search <query>' };
      const hits = await collectLargeFileRecallHits(query, 8);
      const lines = [
        'CognitiveRAG Large File Search',
        `- query: ${query}`,
        `- hits: ${hits.length}`,
      ];
      if (!hits.length) {
        lines.push('- no matching large-file excerpts');
      } else {
        lines.push('- matches:');
        for (const hit of hits) lines.push(`  - [${hit.source}] ${hit.text}`);
      }
      return { text: lines.join('\n') };
    },
  });

  api.registerCommand?.({
    name: 'crag_large_excerpt',
    description: 'Read-only large-file excerpt expansion by excerpt id. Usage: /crag_large_excerpt <excerpt-id>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const target = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      if (!target) return { text: 'Usage: /crag_large_excerpt <excerpt-id>' };
      const entry = await getLargeFileExcerptById(target);
      if (!entry) {
        return {
          text: [
            'CognitiveRAG Large File Excerpt',
            `- excerpt id: ${target}`,
            '- result: not found',
          ].join('\n'),
        };
      }
      return {
        text: [
          'CognitiveRAG Large File Excerpt',
          `- excerpt id: ${entry.excerptId}`,
          `- title: ${entry.title}`,
          `- source path: ${entry.sourcePath}`,
          `- span: ${entry.startOffset}-${entry.endOffset}`,
          '- excerpt:',
          entry.text,
        ].join('\n'),
      };
    },
  });

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
      const largeFileHits = await collectLargeFileRecallHits(query, 8);
      const corpusHits = await collectCorpusRecallHits(query, 8);
      const mirrorHits = await collectMirrorRecallHits(query);
      const combinedRaw = [...backendHits, ...localHits, ...largeFileHits, ...corpusHits, ...mirrorHits];
      const { ranked, intent } = rankRecallHits(query, combinedRaw);
      const combined = ranked.slice(0, 8);
      const winner = combined[0] ?? null;
      const fallbackSourceSet = Array.from(new Set(combined.slice(1).map((row) => row.hit.source)));
      const lines = [
        'CognitiveRAG Recall',
        `- query: ${query}`,
        `- ranking intent: ${intent}`,
        `- all sessions: ${allSessions ? 'yes' : 'no'}`,
        `- sessionKey: ${sessionKey || 'unknown'}`,
        `- sessionId: ${sessionId || 'unknown'}`,
        `- sessionId source: ${sessionIdSource}`,
        `- backend hits: ${backendHits.length}`,
        `- local lossless hits: ${localHits.length}`,
        `- large file hits: ${largeFileHits.length}`,
        `- corpus hits: ${corpusHits.length}`,
        `- fallback mirror hits: ${mirrorHits.length}`,
      ];
      if (winner) {
        lines.push(`- winning source: ${winner.hit.source}`);
        lines.push(`- winning reason: ${winner.reasons.join(', ')}`);
        lines.push(`- fallback sources: ${fallbackSourceSet.length ? fallbackSourceSet.join(', ') : 'none'}`);
        lines.push(
          `- winning provenance: ${winner.hit.corpusPath ?? winner.hit.sessionId ?? winner.hit.chunkId ?? 'text-only'}`,
        );
      } else {
        lines.push('- winning source: none');
      }
      if (!combined.length) {
        lines.push('- hits: none');
      } else {
        lines.push('- hits:');
        for (const row of combined) {
          lines.push(`  - [${row.hit.source}] score=${row.score} ${row.hit.text}`);
        }
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
    name: 'crag_session_quote',
    description:
      'Read-only exact/near-exact older session quote retrieval. Usage: /crag_session_quote [--session-id <id>] [--exact] <query|seq:<n>|seq:<start>-<end>>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const rawInput = Array.isArray(ctx?.args)
        ? ctx.args.join(' ').trim()
        : String(ctx?.args?.text ?? ctx?.args?.message ?? ctx?.args?.value ?? ctx?.args ?? '').trim();
      const exactMode = /(?:^|\s)--exact(?:\s|$)/i.test(rawInput);
      const cleaned = rawInput.replace(/(?:^|\s)--exact(?:\s|$)/gi, ' ').trim();
      const parsed = parseSessionArg(cleaned);
      const target = String(parsed.query ?? '').trim();
      if (!target) {
        return {
          text: 'Usage: /crag_session_quote [--session-id <id>] [--exact] <query|seq:<n>|seq:<start>-<end>>',
        };
      }
      const resolved = resolveCtxSession(ctx);
      const sessionId = parsed.explicitSessionId || resolved.sessionId;
      if (!sessionId) return { text: 'No session id available yet. Provide --session-id <id>.' };
      const entries = await readRawEntries(sessionId);
      const seqRange = target.match(/^seq:(\d+)(?:-(\d+))?$/i);

      const lines: string[] = [
        'CognitiveRAG Session Quote',
        `- sessionId: ${sessionId}`,
        `- target: ${target}`,
        `- exact mode: ${exactMode ? 'yes' : 'no'}`,
      ];

      if (seqRange) {
        const start = Number.parseInt(seqRange[1], 10);
        const end = Number.parseInt(seqRange[2] || seqRange[1], 10);
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        const windowEntries = entries.filter((entry) => entry.seq >= low && entry.seq <= high).slice(0, 40);
        lines.push('- retrieval mode: seq-range');
        lines.push(`- seq range: ${low}-${high}`);
        lines.push(`- source: lossless_session_raw`);
        lines.push(`- hits: ${windowEntries.length}`);
        if (!windowEntries.length) {
          lines.push('- none');
        } else {
          lines.push('- quotes:');
          for (const entry of windowEntries) {
            lines.push(`  - seq ${entry.seq} [${entry.sender}] ${buildSnippet(entry.text, 320)}`);
          }
        }
        return { text: lines.join('\n') };
      }

      const quote = await collectSessionQuoteHits(sessionId, target, exactMode, 8);
      lines.push('- retrieval mode: query');
      lines.push(`- raw exact/near hits: ${quote.raw.length}`);
      lines.push(`- compact summary hits: ${quote.compact.length}`);
      lines.push(`- expanded raw evidence entries: ${quote.expandedFromCompact.length}`);

      if (quote.raw.length) {
        lines.push('- exact raw hits:');
        for (const hit of quote.raw.slice(0, 8)) {
          lines.push(
            `  - [${hit.source}] seq ${hit.seqStart}-${hit.seqEnd} score=${hit.score} exact=${hit.exact ? 'yes' : 'no'} ${hit.text}`,
          );
        }
      }

      if (quote.compact.length) {
        lines.push('- compact hits:');
        for (const hit of quote.compact.slice(0, 6)) {
          lines.push(
            `  - [${hit.source}] ${hit.chunkId} seq ${hit.seqStart}-${hit.seqEnd} score=${hit.score} exact=${hit.exact ? 'yes' : 'no'} ${hit.text}`,
          );
        }
      }

      if (!quote.raw.length && !quote.compact.length) {
        lines.push('- no matching session material found');
      } else if (quote.expandedFromCompact.length) {
        lines.push('- expanded raw evidence:');
        for (const entry of quote.expandedFromCompact.slice(0, 8)) {
          lines.push(`  - seq ${entry.seq} [${entry.sender}] ${buildSnippet(entry.text, 240)}`);
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
      const backendProbe = await fetchBackendAssembleContext(
        COG_RAG_BASE,
        {
          sessionId: '__crag_explain__',
          freshTailCount: 1,
          budget: 512,
          query: 'How is your memory organized?',
          intentFamily: 'architecture_explanation',
        },
        1800,
      ).catch(() => ({
        status: 0,
        body: {},
        explanation: { ok: false, error: 'backend_unreachable' as const },
      }));
      return {
        text: buildCragExplainMemoryText({
          slot,
          fallbackMirrorActive: !!current?.fallbackMemoryMirrorActive,
          explanation: backendProbe.explanation as any,
          onlineLaneStatus: current?.onlineLaneStatus ?? 'unknown',
        }),
      };
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
      await probeBackend();
      const current = await readHealthState();
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
        `- online lane status: ${current?.onlineLaneStatus ?? 'unknown'}`,
        `- online source classes: ${Array.isArray(current?.onlineSourceClasses) && current.onlineSourceClasses.length ? current.onlineSourceClasses.join(', ') : 'none'}`,
        `- online lane last checked: ${current?.onlineLaneLastCheckedAt ?? 'never'}`,
        `- online lane last error: ${current?.onlineLaneLastError ?? 'none'}`,
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
        const latestUserQueryFromPrompt = normalizeNaturalUserQuery(String((params as any)?.prompt ?? ''));
        const latestUserQueryForRouting = latestUserQueryFromPrompt || latestUserQueryFromMessages(inputMessages);
        const preflightIntent = latestUserQueryForRouting ? detectNaturalAnswerIntent(latestUserQueryForRouting) : 'none';
        const backendIntentFamily = toBackendIntentFamily(preflightIntent);
        api.logger?.info?.(
          '[cognitiverag-memory] assemble input ' +
            JSON.stringify({
              sessionId,
              sessionKey: params?.sessionKey ?? null,
              inputMessagesCount: inputMessages.length,
              tokenBudget: budget,
              chosenFreshTailCount: freshTailCount,
              backendIntentFamily,
            }),
        );

        const assemblyRes = await fetchBackendAssembleContext(COG_RAG_BASE, {
          sessionId,
          freshTailCount,
          budget,
          query: latestUserQueryForRouting || undefined,
          intentFamily: backendIntentFamily,
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
              backendExplanationValid: !!assemblyRes?.explanation?.ok,
              backendExplanationError: assemblyRes?.explanation?.ok ? null : assemblyRes?.explanation?.error ?? null,
            }),
        );

        const shaped = shapeAssembleResponse(assemblyRes, budget);
        let { messages, systemPromptAddition, estimatedTokens, totalTokens } = shaped;
        const backendSelectorPrompt = buildBackendSelectorPrompt(assemblyRes.explanation);
        if (backendSelectorPrompt) {
          systemPromptAddition = systemPromptAddition
            ? `${systemPromptAddition}\n\n${backendSelectorPrompt}`
            : backendSelectorPrompt;
        }
        let naturalRoutingMessage: any = null;
        let naturalIntent: NaturalAnswerIntent = 'none';
        let naturalDraft: NaturalAnswerDraft | null = null;
        let deterministicComposerActive = false;
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
          const latestUserQueryForIntent = latestUserQueryForRouting;
          naturalIntent = latestUserQueryForIntent ? detectNaturalAnswerIntent(latestUserQueryForIntent) : 'none';
          let fallbackPrompt = `Fallback memory mirror (durable user-noted facts):\n${fallbackSummary}`;
          if (naturalIntent === 'corpus') {
            fallbackPrompt =
              'Fallback memory mirror note: mirror metadata exists, but for corpus/book questions prioritize corpus/large-file/session evidence over mirror token lists.';
          } else if (naturalIntent === 'memory_summary') {
            const mirrorBullets = Array.from(
              new Set([...(await collectMemoryBullets(memoryFile)), ...(await collectMemoryBullets(workspaceMemoryFile))]),
            );
            const nonTokenBullets = mirrorBullets.filter((line) => !looksLikeOpaqueToken(line)).slice(0, 4);
            const tokenCount = Math.max(0, mirrorBullets.length - nonTokenBullets.length);
            const compact = [
              'Fallback memory mirror (summary only):',
              ...nonTokenBullets.map((line) => `- ${buildSnippet(line, 160)}`),
              tokenCount > 0 ? `- opaque tokens available on explicit request: ${tokenCount}` : '',
            ]
              .filter(Boolean)
              .join('\n');
            fallbackPrompt = compact;
          }
          systemPromptAddition = systemPromptAddition
            ? `${systemPromptAddition}\n\n${fallbackPrompt}`
            : fallbackPrompt;
        }
        const architecturePrompt =
          'Memory architecture truth: cognitiverag-memory is active. Backend/session memory is primary CRAG context; plugin-local lossless session layer stores exact + compacted history; corpus_memory stores normal chunked files; large_file_store keeps oversized files as bounded summaries + excerpt locators; MEMORY.md fallback mirror is auxiliary.';
        systemPromptAddition = systemPromptAddition
          ? `${systemPromptAddition}\n\n${architecturePrompt}`
          : architecturePrompt;

        const latestUserQuery = latestUserQueryForRouting;
        if (latestUserQuery) {
          naturalIntent = detectNaturalAnswerIntent(latestUserQuery);
          const naturalRoutingPrompt = await buildNaturalRoutingPrompt(sessionId, latestUserQuery);
          naturalDraft = await buildNaturalAnswerDraft(sessionId, latestUserQuery);
          if (naturalRoutingPrompt) {
            deterministicComposerActive =
              !!naturalDraft &&
              (naturalIntent === 'memory_summary' || naturalIntent === 'corpus' || naturalIntent === 'architecture');
            const hardContract = deterministicComposerActive
              ? naturalIntent === 'memory_summary'
                ? '\n\nDeterministic final-answer contract for memory summary:\n- Output six sections exactly: Memory stack in use (primary -> supporting); About you; Recent durable facts; Current conversation context; Books/corpus I can draw from; What I am still missing.\n- Do not list more than two opaque token IDs unless user explicitly asks for exact token inventory.\n- Keep CRAG/session/corpus layers primary and markdown mirrors explicitly secondary.'
                : naturalIntent === 'corpus'
                  ? '\n\nDeterministic final-answer contract for corpus overview:\n- If retrieved corpus excerpts exist, summarize from those excerpts directly.\n- Do not return title/path-only fallback when excerpt evidence is present.\n- End with a short Source line using path/title from winning excerpt.'
                  : '\n\nDeterministic final-answer contract for architecture/source questions:\n- Answer from layered memory truth contract directly.\n- Keep CRAG/lossless/corpus layers explicit and markdown mirrors secondary.\n- Do not emit provider-error or empty fallback text for this intent.'
              : '';
            const draftBlock = naturalDraft
              ? `\n\nDeterministic answer draft (preserve this substance in final answer):\n${naturalDraft.text}\n\nSource basis:\n${naturalDraft.sourceBasis
                  .map((line) => `- ${line}`)
                  .join('\n')}`
              : '';
            systemPromptAddition = systemPromptAddition
              ? `${systemPromptAddition}\n\n${naturalRoutingPrompt}${hardContract}${draftBlock}`
              : `${naturalRoutingPrompt}${hardContract}${draftBlock}`;
            naturalRoutingMessage = {
              role: 'system',
              content: toContentBlocks(
                `Automatic retrieval context for current user query:\n${naturalRoutingPrompt}\n\n` +
                  `${hardContract ? `${hardContract}\n\n` : ''}` +
                  `${naturalDraft ? `Deterministic answer draft:\n${naturalDraft.text}\n\n` : ''}` +
                  'Use this context directly in the answer. Prefer concise, source-aware natural language. Do not default to mirror token dumps when richer evidence exists.',
              ),
            };
          }
        }
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
              naturalIntent,
              hasNaturalDraft: !!naturalDraft,
              naturalDraftChars: (naturalDraft?.text ?? '').length,
              deterministicComposerActive,
              shapedEstimatedTokens: estimatedTokens ?? null,
              shapedTotalTokens: totalTokens ?? null,
            }),
        );

        const boundedMessages = Array.isArray(messages) ? messages.slice(-20) : [];
        messages = pruneMessagesForDeterministicIntent(boundedMessages, naturalIntent);
        if (deterministicComposerActive && naturalDraft) {
          const latestUserQueryForDeterministic =
            normalizeNaturalUserQuery(String((params as any)?.prompt ?? '')) ||
            latestUserQueryFromMessages(inputMessages);
          const hardShortCircuit = buildHardDeterministicMessages(
            naturalIntent,
            latestUserQueryForDeterministic,
            naturalDraft,
          );
          if (hardShortCircuit.length) {
            messages = hardShortCircuit;
            systemPromptAddition = undefined;
            naturalRoutingMessage = null;
          } else {
            messages = enforceDeterministicDraftOnLastUser(
              messages,
              naturalIntent,
              latestUserQueryForDeterministic,
              naturalDraft,
            );
          }
        }
        if (naturalRoutingMessage) {
          messages = [...messages, naturalRoutingMessage];
        }
        if (messages.length > 20) messages = messages.slice(-20);
        estimatedTokens = Math.max(
          0,
          messages.reduce((n: number, m: any) => n + Math.ceil(extractTextContent(m?.content).length / 4), 0) +
            Math.ceil((systemPromptAddition ?? '').length / 4),
        );
        totalTokens = estimatedTokens;

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
            naturalIntent,
            hasNaturalDraft: !!naturalDraft,
            naturalDraftChars: (naturalDraft?.text ?? '').length,
            deterministicComposerActive,
            hardShortCircuitMessages: deterministicComposerActive && !!naturalDraft ? messages.length : 0,
          })}`,
        );

        if (assemblyRes.status >= 200 && assemblyRes.status < 300) await markSuccess();
        else await markFail(`assemble_status_${assemblyRes.status}`);

        return toEngineAssembleResult({
          messages,
          estimatedTokens,
          totalTokens,
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
    await probeBackend();
    const current = await readHealthState();
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
      onlineLaneStatus: current?.onlineLaneStatus ?? 'unknown',
      onlineSourceClasses: Array.isArray(current?.onlineSourceClasses) ? current.onlineSourceClasses : [],
      onlineLaneLastCheckedAt: current?.onlineLaneLastCheckedAt ?? null,
      onlineLaneLastError: current?.onlineLaneLastError ?? null,
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
          onlineLaneStatus: 'unknown',
          onlineSourceClasses: [],
          onlineLaneLastCheckedAt: null,
          onlineLaneLastError: String(e?.message ?? e),
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
