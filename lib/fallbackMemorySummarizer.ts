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
};

// Defaults are deterministic and local-only. Exported for tests to verify.
export const DEFAULTS: Required<SummarizerOptions> = {
  // plugin-local path: inside this package folder
  pluginMemoryPath: path.resolve(process.cwd(), 'openclaw-cognitiverag-memory', 'MEMORY.md'),
  // workspaceMemoryPath should be the workspace root's MEMORY.md and must NOT equal pluginMemoryPath
  workspaceMemoryPath: path.resolve(process.cwd(), '..', '..', 'MEMORY.md'),
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

  // Combine with workspace lines later (workspace preferred for exactness)
  const combined = [...pluginLines, ...workspaceLines];
  const deduped = dedupePreserveOrder(combined);
  const sliced = deduped.slice(-Math.max(cfg.maxMessages, cfg.maxLines));

  const summary = buildSummaryFromLines(sliced, cfg.maxSummaryChars);
  const messages = buildMessagesFromLines(sliced, cfg.maxMessages);

  return {
    summary,
    messages,
    sourceCounts: { plugin: pluginLines.length, workspace: workspaceLines.length },
  };
}
