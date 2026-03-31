export type NaturalAnswerIntent =
  | 'memory_summary'
  | 'memory_topic'
  | 'architecture'
  | 'corpus'
  | 'chat_recall'
  | 'knowledge'
  | 'skill_generation'
  | 'skill_explain'
  | 'skill_evaluation'
  | 'none';

export function normalizeNaturalUserQuery(input: string): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

export function detectNaturalAnswerIntent(query: string): NaturalAnswerIntent {
  const q = normalizeNaturalUserQuery(query).toLowerCase();
  if (!q) return 'none';

  if (
    /what do you remember about .+/.test(q) ||
    /what do you remember of .+/.test(q) ||
    /do you remember anything about .+/.test(q) ||
    /do you remember any book about .+/.test(q) ||
    q.includes('do you remember any complete book')
  ) {
    return 'memory_topic';
  }

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
    q.includes('explain your memory layers') ||
    q.includes('distinguish memory.md') ||
    q.includes('backend memory, corpus memory, web evidence') ||
    q.includes('which evidence sources would you check next') ||
    q.includes('session memory, promoted memory, corpus, or web') ||
    q.includes('how is your memory organized') ||
    q.includes('where is this stored') ||
    q.includes('what is stored in memory.md') ||
    q.includes('what comes from backend/session memory') ||
    q.includes('where did this answer come from') ||
    q.includes('from memory vs corpus')
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
    q.includes('write a 30-second recipe short') ||
    q.includes('write a 30 second recipe short') ||
    q.includes('give me a storyboard for it') ||
    q.includes('give me a storyboard') ||
    q.includes('second variant optimized for stronger hook retention') ||
    q.includes('second variant optimized for hook retention')
  ) {
    return 'skill_generation';
  }

  if (
    q.includes('which principles/templates/examples/rubric/anti-patterns you used') ||
    q.includes('which principles you used') ||
    q.includes('which templates you used') ||
    q.includes('what source class did that answer rely on most') ||
    q.includes('did you store an execution case for the previous run') ||
    q.includes('what artifacts were used in that execution case') ||
    q.includes('show me a similar prior execution case') ||
    q.includes('why is that prior execution case similar') ||
    q.includes('what anti-patterns did you try to avoid in that storyboard')
  ) {
    return 'skill_explain';
  }

  if (
    q.includes('score a generated output with a rubric') ||
    q.includes('score this output with a rubric') ||
    q.includes('evaluate this output with a rubric') ||
    q.includes('score the previous output with a rubric') ||
    q.includes('did you store an evaluation case for that') ||
    q.includes('main weaknesses and anti-pattern hits') ||
    q.includes('show me the strongest prior evaluation for a similar task')
  ) {
    return 'skill_evaluation';
  }

  if (
    /what do you know about .+/.test(q) ||
    /do you know anything about .+/.test(q) ||
    /what do you know of .+/.test(q)
  ) {
    return 'knowledge';
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
  if (intent === 'memory_topic') return 'memory_summary';
  if (intent === 'architecture') return 'architecture_explanation';
  if (intent === 'corpus') return 'corpus_overview';
  if (intent === 'chat_recall') return 'exact_recall';
  if (intent === 'skill_generation' || intent === 'skill_explain' || intent === 'skill_evaluation') return 'planning';
  return null;
}
