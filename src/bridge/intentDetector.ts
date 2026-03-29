export type NaturalAnswerIntent = 'memory_summary' | 'architecture' | 'corpus' | 'chat_recall' | 'none';

export function normalizeNaturalUserQuery(input: string): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

export function detectNaturalAnswerIntent(query: string): NaturalAnswerIntent {
  const q = normalizeNaturalUserQuery(query).toLowerCase();
  if (!q) return 'none';

  if (
    q.includes('what do you remember') ||
    q.includes('what are you remembering') ||
    q.includes('what do you know about me') ||
    q.includes('how is your memory')
  ) {
    return 'memory_summary';
  }

  if (
    q.includes('are you using crag') ||
    q.includes('do you use crag') ||
    q.includes('crag lossless memory') ||
    q.includes('how is your memory organized') ||
    q.includes('where is this stored') ||
    q.includes('what is stored in memory.md') ||
    q.includes('what comes from backend/session memory') ||
    q.includes('where did this answer come from')
  ) {
    return 'architecture';
  }

  if (
    q.includes('what did we say earlier') ||
    q.includes('what was the token') ||
    q.includes('from before') ||
    q.includes('quote the earlier') ||
    q.includes('we discussed')
  ) {
    return 'chat_recall';
  }

  if (
    q.includes('what can you tell me about') ||
    q.includes('synopsis') ||
    q.includes('book') ||
    q.includes('chapter') ||
    q.includes('youtube secrets') ||
    q.includes('from corpus')
  ) {
    return 'corpus';
  }

  return 'none';
}

export function toBackendIntentFamily(intent: NaturalAnswerIntent): string | null {
  if (intent === 'memory_summary') return 'memory_summary';
  if (intent === 'architecture') return 'architecture_explanation';
  if (intent === 'corpus') return 'corpus_overview';
  if (intent === 'chat_recall') return 'exact_recall';
  return null;
}

