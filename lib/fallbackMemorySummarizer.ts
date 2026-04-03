import { promises as fs } from 'node:fs';
import path from 'node:path';

export type SummarizerOptions = {
  pluginMemoryPath?: string; // plugin-local MEMORY.md
  workspaceMemoryPath?: string; // workspace MEMORY.md
  maxLines?: number; // how many most-recent lines to consider from each source
  maxSummaryChars?: number; // max chars in returned summary
  maxMessages?: number; // max messages to return
};

export type SummarizerResult = {
  summary: string; // small bounded summary text
  messages: { role: 'user' | 'system' | 'assistant'; content: string }[]; // bounded messages array
  sourceCounts: { plugin?: number; workspace?: number };
  cleanedLines: string[];
  cleanupStats: {
    exactDuplicatesRemoved: number;
    nearDuplicatesRemoved: number;
    boilerplateRemoved: number;
    tokenNoiseRemoved: number;
  };
  compactionAware: boolean;
};

// Defaults are deterministic and local-only. Exported for tests to verify.
export const DEFAULTS: Required<SummarizerOptions> = {
  // plugin-local path: repo-local MEMORY.md when cwd is repo root
  pluginMemoryPath: path.resolve(process.cwd(), 'MEMORY.md'),
  // workspaceMemoryPath: workspace root's MEMORY.md (parent of repo), distinct from pluginMemoryPath
  workspaceMemoryPath: path.resolve(process.cwd(), '..', 'MEMORY.md'),
  maxLines: 50,
  maxSummaryChars: 1024,
  maxMessages: 10,
};

function normalizeLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function dedupePreserveOrder(lines: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function normalizeForCompare(line: string): string {
  return String(line ?? '')
    .trim()
    .replace(/^\-\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function looksLikeTokenNoise(line: string): boolean {
  const normalized = normalizeForCompare(line);
  if (!normalized) return false;
  if (/(^|[\s:])([a-f0-9]{24,}|[a-z0-9_-]{32,})([\s]|$)/i.test(normalized)) return true;
  if (/^(token|hash|id|fingerprint|digest)\s*[:=]/i.test(normalized)) return true;
  return false;
}

function looksLikeBoilerplate(line: string): boolean {
  const normalized = normalizeForCompare(line);
  if (!normalized) return false;
  return (
    /^memory (stack|architecture|summary)\b/.test(normalized) ||
    /^fallback memory mirror\b/.test(normalized) ||
    /^markdown mirrors?\b/.test(normalized) ||
    /^deterministic final-answer contract\b/.test(normalized) ||
    /^answer contract\b/.test(normalized) ||
    /^answer quality rule\b/.test(normalized) ||
    /^sender \(untrusted metadata\)\b/.test(normalized)
  );
}

function nearDuplicateKey(line: string): string {
  const normalized = normalizeForCompare(line)
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const parts = normalized.split(' ').filter(Boolean).slice(0, 14);
  return parts.join(' ');
}

function tokenize(line: string): string[] {
  return normalizeForCompare(line)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function tokenOverlapRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / Math.max(setA.size, setB.size);
}

function cleanMirrorLines(lines: string[]) {
  const cleaned: string[] = [];
  const exactIndex = new Map<string, number>();
  const nearIndex = new Map<string, number>();
  let exactDuplicatesRemoved = 0;
  let nearDuplicatesRemoved = 0;
  let boilerplateRemoved = 0;
  let tokenNoiseRemoved = 0;

  for (const original of lines) {
    const line = String(original ?? '')
      .trim()
      .replace(/^\-\s*/, '')
      .replace(/\s+/g, ' ');
    if (!line) continue;
    if (looksLikeBoilerplate(line)) {
      boilerplateRemoved += 1;
      continue;
    }
    if (looksLikeTokenNoise(line)) {
      tokenNoiseRemoved += 1;
      continue;
    }

    const exactKey = normalizeForCompare(line);
    if (exactIndex.has(exactKey)) {
      cleaned[exactIndex.get(exactKey)!] = line; // keep most recent wording deterministically
      exactDuplicatesRemoved += 1;
      continue;
    }

    const nearKey = nearDuplicateKey(line);
    if (nearKey && nearIndex.has(nearKey)) {
      const previousIdx = nearIndex.get(nearKey)!;
      const prev = cleaned[previousIdx] ?? '';
      const ratio = tokenOverlapRatio(tokenize(prev), tokenize(line));
      if (ratio >= 0.86) {
        cleaned[previousIdx] = line;
        nearDuplicatesRemoved += 1;
        continue;
      }
    }

    const idx = cleaned.length;
    cleaned.push(line);
    exactIndex.set(exactKey, idx);
    if (nearKey) nearIndex.set(nearKey, idx);
  }

  return {
    cleaned,
    stats: { exactDuplicatesRemoved, nearDuplicatesRemoved, boilerplateRemoved, tokenNoiseRemoved },
  };
}

export async function readLinesSafe(p: string, maxLines: number) {
  try {
    const raw = await fs.readFile(p, 'utf8').catch(() => '');
    const lines = normalizeLines(raw);
    // return most recent lines (tail)
    if (lines.length <= maxLines) return lines;
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function buildSummaryFromLines(lines: string[], maxChars: number) {
  if (!lines || !lines.length) return '';
  const bullets = lines.map((l) => `- ${l.replace(/\s+/g, ' ').trim()}`);
  let out = '';
  for (const b of bullets) {
    if ((out + '\n' + b).trim().length > maxChars) break;
    out = out ? `${out}\n${b}` : b;
  }
  if (out.length > maxChars) return out.slice(0, maxChars - 1) + '…';
  return out;
}

export function buildMessagesFromLines(lines: string[], maxMessages: number) {
  const msgs: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
  for (const l of lines.slice(-maxMessages)) {
    const content = l.length > 1000 ? l.slice(0, 1000) + '…' : l;
    msgs.push({ role: 'user', content });
  }
  return msgs;
}

export async function summarizeFallback(opts?: SummarizerOptions): Promise<SummarizerResult> {
  const cfg = { ...DEFAULTS, ...(opts ?? {}) } as Required<SummarizerOptions>;
  const pluginLines = await readLinesSafe(cfg.pluginMemoryPath, cfg.maxLines).catch(() => []);
  const workspaceLines = await readLinesSafe(cfg.workspaceMemoryPath, cfg.maxLines).catch(() => []);

  // Combine plugin + workspace; cleanup keeps the most recent surviving entry deterministically.
  const combined = [...pluginLines, ...workspaceLines];
  const deduped = dedupePreserveOrder(combined);
  const { cleaned, stats } = cleanMirrorLines(deduped);
  const sliced = cleaned.slice(-Math.max(cfg.maxMessages, cfg.maxLines));
  const compactionAware = sliced.some((line) => /\b(compact|compacted|recover|recoverable|quote|expand)\b/i.test(line));

  const summary = buildSummaryFromLines(sliced, cfg.maxSummaryChars);
  const messages = buildMessagesFromLines(sliced, cfg.maxMessages);

  return {
    summary,
    messages,
    cleanedLines: sliced,
    cleanupStats: stats,
    compactionAware,
    sourceCounts: { plugin: pluginLines.length, workspace: workspaceLines.length },
  };
}
