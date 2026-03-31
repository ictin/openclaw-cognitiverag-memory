import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function safeParseGatewayJson(raw) {
  const idx = raw.indexOf('{');
  if (idx < 0) throw new Error('No JSON payload in gateway output');
  return JSON.parse(raw.slice(idx));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleepMs(ms) {
  execSync(`sleep ${Math.max(0, ms) / 1000}`, { stdio: 'pipe', shell: '/bin/bash' });
}

function isRetryableGatewayError(error) {
  const text = String(error?.message ?? error ?? '');
  return (
    text.includes('gateway closed') ||
    text.includes('ECONNREFUSED') ||
    text.includes('connect ECONNREFUSED') ||
    text.includes('abnormal closure') ||
    text.includes('timed out')
  );
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function all(rxList, text) {
  const t = String(text || '');
  return rxList.every((rx) => rx.test(t));
}

function any(rxList, text) {
  const t = String(text || '');
  return rxList.some((rx) => rx.test(t));
}

function updateIdsFromText(ctx, text) {
  const t = String(text || '');
  const execIds = t.match(/exec:[a-f0-9]{8,}/gi) || [];
  const evalIds = t.match(/eval:[a-f0-9]{8,}/gi) || [];
  for (const id of execIds) {
    if (!ctx.executionIds.includes(id)) ctx.executionIds.push(id);
  }
  for (const id of evalIds) {
    if (!ctx.evaluationIds.includes(id)) ctx.evaluationIds.push(id);
  }
  if (ctx.executionIds.length) ctx.lastExecutionId = ctx.executionIds[ctx.executionIds.length - 1];
  if (ctx.evaluationIds.length) ctx.lastEvaluationId = ctx.evaluationIds[ctx.evaluationIds.length - 1];
}

function scoreById(testId, responseText, ctx) {
  const text = String(responseText || '');
  const lower = text.toLowerCase();

  switch (testId) {
    case 'T0.1': {
      const full = all([
        /CognitiveRAG Status/i,
        /backend ownership:\s*canonical/i,
        /markdown mirrors role:\s*support\/export\/debug/i,
      ], text);
      return full ? { score: 2, reason: 'backend-first status surfaced' } : any([/CognitiveRAG Status/i, /contextEngine slot/i], text)
        ? { score: 1, reason: 'status present but wording weak' }
        : { score: 0, reason: 'status missing required backend-first framing' };
    }
    case 'T0.2': {
      const full = all([
        /backend\/session memory/i,
        /backend promoted memory/i,
        /corpus layer/i,
        /large-file layer/i,
        /web evidence/i,
        /web promoted/i,
        /mirrors.*support\/export\/debug/i,
      ], text);
      return full ? { score: 2, reason: 'full memory layer distinction present' } : any([/Memory Architecture/i, /backend\/session/i], text)
        ? { score: 1, reason: 'partial architecture distinction' }
        : { score: 0, reason: 'memory architecture distinction missing' };
    }
    case 'T0.3': {
      const full = all([
        /backend.*canonical|backend\/session/i,
        /MEMORY\.md.*mirror|mirrors?/i,
        /web evidence/i,
        /web promoted/i,
      ], text);
      return full ? { score: 2, reason: 'plain-language architecture truthful' } : any([/memory layers/i, /backend/i], text)
        ? { score: 1, reason: 'partial distinction in plain-language answer' }
        : { score: 0, reason: 'plain-language architecture not aligned' };
    }
    case 'T1.1':
      return /\bSTORED\b/.test(text) ? { score: 2, reason: 'acknowledged store command exactly' } : { score: 0, reason: 'did not reply STORED' };
    case 'T1.2': {
      const full = all([
        /favorite_stack:\s*C#\s*\+\s*C\+\+/i,
        /current_blocker:\s*legacy \/query path/i,
        /reusable_workflow:\s*read plan -> implement -> run targeted tests -> run full suite/i,
      ], text);
      return full ? { score: 2, reason: 'exact recall of all three items' } : any([/favorite_stack|current_blocker|reusable_workflow/i], text)
        ? { score: 1, reason: 'partial recall' }
        : { score: 0, reason: 'failed exact recall' };
    }
    case 'T1.3':
      return all([/current_blocker:/i, /reusable_workflow:/i], text)
        ? { score: 2, reason: 'returned blocker + workflow only' }
        : any([/current_blocker|reusable_workflow/i], text)
          ? { score: 1, reason: 'partial subset recall' }
          : { score: 0, reason: 'missing requested subset recall' };
    case 'T1.4':
      return any([/session recall|this session|session memory/i, /promoted memory/i], text)
        ? { score: 2, reason: 'provenance distinction provided' }
        : { score: 0, reason: 'provenance distinction missing' };
    case 'T2.1':
    case 'T2.3':
    case 'T2.4':
      return any([/remembered evidence for topic|stored remembered evidence/i, /I do not currently have stored remembered evidence/i], text)
        ? { score: 2, reason: 'remember intent routed to memory-aware behavior' }
        : { score: 0, reason: 'remember intent not memory-scoped' };
    case 'T2.2':
      return any([/general knowledge|not from stored memory/i, /NLP/i], text)
        ? { score: 2, reason: 'know path allowed and labeled' }
        : { score: 0, reason: 'know path mislabeled or missing' };
    case 'T2.5':
    case 'T2.6':
      return all([/do not store complete books as one monolithic/i, /chunked corpus\/large-file evidence/i], text)
        ? { score: 2, reason: 'complete-book model explained correctly' }
        : any([/complete books?/i, /corpus/i], text)
          ? { score: 1, reason: 'partial complete-book explanation' }
          : { score: 0, reason: 'complete-book answer shape failed' };
    case 'T3.1':
      return any([/memory vs corpus/i, /backend\/session|corpus/i], text)
        ? { score: 2, reason: 'memory-vs-corpus distinction present' }
        : { score: 0, reason: 'memory-vs-corpus distinction missing' };
    case 'T3.2':
    case 'T3.3':
    case 'T3.4':
      return any([/source|path|span|provenance|excerpt/i], text)
        ? { score: 1, reason: 'some corpus/provenance signal present' }
        : { score: 0, reason: 'corpus provenance not surfaced' };
    case 'T4.1':
    case 'T4.2':
    case 'T4.3': {
      const explicit = any([/raw web evidence|web promoted|source class/i], text);
      const honestFail = any([/unavailable|cannot verify|web.*unavailable|do not guess/i], text);
      return explicit || honestFail
        ? { score: 2, reason: explicit ? 'web class distinction present' : 'honest web unavailability' }
        : { score: 0, reason: 'web source-class truthfulness missing' };
    }
    case 'T4.4':
      return any([/if the web is unavailable|unavailable|cannot verify/i], text)
        ? { score: 2, reason: 'honest failure handling present' }
        : { score: 1, reason: 'answered without explicit unavailability guard' };
    case 'T5.1': {
      const bounded = (text.match(/\n\s*[-\d]+[.)-]?\s+/g) || []).length <= 5 || /at most 5|5 discoveries/i.test(text);
      const contra = any([/contradiction|unresolved question|none/i], text);
      return bounded && contra ? { score: 2, reason: 'bounded discovery with contradiction handling' }
        : bounded ? { score: 1, reason: 'bounded but contradiction labeling weak' }
        : { score: 0, reason: 'discovery not bounded' };
    }
    case 'T5.2':
      return any([/weakest|alternative branch|explore instead/i], text)
        ? { score: 2, reason: 'backtracking-style branch handling present' }
        : { score: 0, reason: 'weak-branch alternative missing' };
    case 'T5.3':
      return any([/session memory|promoted memory|corpus|web/i], text)
        ? { score: 2, reason: 'source prioritization explicit' }
        : { score: 0, reason: 'source prioritization missing' };
    case 'T5.4':
      return any([/contradiction|none/i], text)
        ? { score: 2, reason: 'contradiction state answered' }
        : { score: 0, reason: 'contradiction state missing' };
    case 'T6.1':
      return any([/30-second recipe short script|skill-memory guided/i], text)
        ? { score: 2, reason: 'skill-guided script generated' }
        : { score: 0, reason: 'script generation not skill-guided' };
    case 'T6.2':
      return any([/principle|template|example|rubric|anti-pattern|workflow/i], text)
        ? { score: 2, reason: 'skill categories explained' }
        : { score: 0, reason: 'skill categories not explained' };
    case 'T6.3':
      return any([/Source class:/i, /skill memory pack|corpus|general model knowledge/i], text)
        ? { score: 2, reason: 'source class answer explicit' }
        : { score: 0, reason: 'source class not explicit' };
    case 'T6.4':
      return any([/variant|hook|retention/i], text)
        ? { score: 1, reason: 'variant response present' }
        : { score: 0, reason: 'variant generation missing' };
    case 'T7.1':
      return any([/Storyboard \(skill-memory guided\)/i, /Scene 1/i], text)
        ? { score: 2, reason: 'storyboard generated' }
        : { score: 0, reason: 'storyboard missing' };
    case 'T7.2':
      return any([/Skill-memory usage for execution case/i, /principle|template|example|rubric|anti-pattern/i], text)
        ? { score: 2, reason: 'storyboard skill-use explanation present' }
        : { score: 0, reason: 'storyboard skill-use explanation missing' };
    case 'T7.3':
      return any([/anti-pattern/i, /none explicit/i], text)
        ? { score: 2, reason: 'anti-pattern handling explicit' }
        : { score: 0, reason: 'anti-pattern handling missing' };
    case 'T8.1':
      return any([/Execution case stored|execution case.*exec:/i], text)
        ? { score: 2, reason: 'execution case write/read confirmed' }
        : { score: 0, reason: 'execution case confirmation missing' };
    case 'T8.2':
      return any([/used .* selected artifacts|selected artifacts:/i], text)
        ? { score: 2, reason: 'artifact usage surfaced' }
        : { score: 0, reason: 'artifact usage missing' };
    case 'T8.3':
      return any([/Similar prior execution case:/i, /No similar prior execution case/i], text)
        ? { score: 2, reason: 'similar-execution retrieval answered' }
        : { score: 0, reason: 'similar-execution retrieval missing' };
    case 'T8.4':
      return any([/Similarity reasons:/i, /similarity heuristic/i], text)
        ? { score: 2, reason: 'similarity rationale provided' }
        : { score: 0, reason: 'similarity rationale missing' };
    case 'T9.1':
      return any([/Rubric evaluation for execution/i, /Evaluation memory write: saved/i], text)
        ? { score: 2, reason: 'rubric evaluation route active' }
        : { score: 0, reason: 'rubric evaluation route missing' };
    case 'T9.2':
      return any([/Evaluation case stored: eval:/i, /No evaluation case/i], text)
        ? { score: 2, reason: 'evaluation-case readback answered' }
        : { score: 0, reason: 'evaluation-case readback missing' };
    case 'T9.3':
      return any([/weaknesses|anti-pattern hits/i], text)
        ? { score: 2, reason: 'weakness/anti-pattern details present' }
        : { score: 0, reason: 'weakness/anti-pattern details missing' };
    case 'T9.4':
      return any([/Strongest prior similar evaluation:/i, /No strong prior evaluation/i], text)
        ? { score: 2, reason: 'prior evaluation retrieval answered' }
        : { score: 0, reason: 'prior evaluation retrieval missing' };
    case 'T10.1':
    case 'T10.2':
    case 'T10.3':
    case 'T10.4':
      return any([/remember|know|corpus|promoted memory/i], text)
        ? { score: 1, reason: 'distinction partly surfaced' }
        : { score: 0, reason: 'distinction not surfaced' };
    case 'T11.1':
    case 'T11.2':
    case 'T11.3': {
      const noisy = any([/ENOTFOUND|fetch failed|toolResult|validation token/i], text);
      return noisy ? { score: 0, reason: 'memory summary still noisy' } : { score: 2, reason: 'noise suppression holds' };
    }
    case 'T12.1':
      return any([/do not guess|unavailable|raw web evidence|source class/i], text)
        ? { score: 2, reason: 'failure-safe behavior present' }
        : { score: 0, reason: 'failure-safe behavior missing' };
    case 'T12.2':
      return any([/promoted memory/i, /influence on final answers/i], text)
        ? { score: 2, reason: 'promoted-memory influence summary present' }
        : { score: 0, reason: 'promoted-memory influence summary missing' };
    case 'T12.3':
      return any([/cannot verify|unverified|not sure|none/i], text)
        ? { score: 2, reason: 'uncertainty surfaced honestly' }
        : { score: 1, reason: 'uncertainty answer weak' };
    case 'T13.1':
    case 'T13.2':
    case 'T13.3':
      return any([/remembered evidence|stored remembered evidence|skill-memory guided|principle|template|rubric/i], text)
        ? { score: 1, reason: 'cross-model behavior acceptable' }
        : { score: 0, reason: 'cross-model routing weak' };
    case 'T14.1':
      return any([/CognitiveRAG Status/i, /backend ownership:\s*canonical/i], text)
        ? { score: 2, reason: 'restart status persisted' }
        : { score: 0, reason: 'restart status failed' };
    case 'T14.2':
      return any([/CognitiveRAG Memory Architecture/i, /mirrors.*support\/export\/debug/i], text)
        ? { score: 2, reason: 'restart explain-memory persisted' }
        : { score: 0, reason: 'restart explain-memory failed' };
    case 'T14.3':
      return any([/remembered evidence for topic|stored remembered evidence/i], text)
        ? { score: 2, reason: 'restart memory-intent persisted' }
        : { score: 1, reason: 'restart memory-intent weak' };
    case 'T14.4':
      return any([/Similar prior execution case|execution case/i], text)
        ? { score: 2, reason: 'restart execution retrieval persisted' }
        : { score: 0, reason: 'restart execution retrieval failed' };
    case 'T15.1':
    case 'T15.2':
    case 'T15.3':
      return any([/ok/i], text) ? { score: 2, reason: 'direct backend persistence check ok' } : { score: 0, reason: 'direct backend persistence check failed' };
    default:
      return { score: 0, reason: 'no scorer implemented' };
  }
}

const CRITICAL = new Set(['T0.1', 'T0.2', 'T4.1', 'T5.1', 'T6.1', 'T7.1', 'T8.1', 'T9.1', 'T12.2', 'T14.1', 'T14.2']);

const GROUPS = [
  {
    id: 'G0',
    title: 'status and explain',
    session: 'core',
    tests: [
      { id: 'T0.1', prompt: '/crag_status' },
      { id: 'T0.2', prompt: '/crag_explain_memory' },
      { id: 'T0.3', prompt: 'Explain your memory layers. Distinguish MEMORY.md, backend memory, corpus memory, web evidence, and web promoted memory.' },
    ],
  },
  {
    id: 'G1',
    title: 'session recall',
    session: 'recall',
    tests: [
      { id: 'T1.1', prompt: 'For this test session, remember these exact items without rewording them:\n\nfavorite_stack: C# + C++\ncurrent_blocker: legacy /query path\nreusable_workflow: read plan -> implement -> run targeted tests -> run full suite\n\nReply with exactly: STORED' },
      { id: 'T1.2', prompt: 'Quote exactly the three items I asked you to remember.' },
      { id: 'T1.3', prompt: 'Now tell me only the blocker and reusable workflow.' },
      { id: 'T1.4', prompt: 'Where did that information come from? Distinguish session recall from promoted memory if relevant.' },
    ],
  },
  {
    id: 'G2',
    title: 'memory-intent routing',
    session: 'memory_intent',
    tests: [
      { id: 'T2.1', prompt: 'What do you remember about NLP?' },
      { id: 'T2.2', prompt: 'What do you know about NLP?' },
      { id: 'T2.3', prompt: 'What do you remember about NLP hypnosis?' },
      { id: 'T2.4', prompt: 'Do you remember anything about psychology?' },
      { id: 'T2.5', prompt: 'Do you remember any complete book?' },
      { id: 'T2.6', prompt: 'Do you remember any complete book about copywriting?' },
    ],
  },
  {
    id: 'G3',
    title: 'corpus retrieval',
    session: 'corpus',
    tests: [
      { id: 'T3.1', prompt: 'What do you know from memory vs corpus about copywriting?' },
      { id: 'T3.2', prompt: 'Show me an excerpt from a copywriting-related book you have in corpus memory, and include provenance.' },
      { id: 'T3.3', prompt: 'What source did that excerpt come from? Give the exact file or path if available.' },
      { id: 'T3.4', prompt: 'Summarize what that book says about hooks, but keep source provenance visible.' },
    ],
  },
  {
    id: 'G4',
    title: 'web evidence',
    session: 'web',
    tests: [
      { id: 'T4.1', prompt: 'What is the latest Bitcoin price right now? Tell me whether this comes from raw web evidence or promoted web memory, and state the source class explicitly.' },
      { id: 'T4.2', prompt: 'What is the latest Bitcoin price right now? Tell me again whether this comes from raw web evidence or promoted web memory, and state the source class explicitly.' },
      { id: 'T4.3', prompt: 'What was the source for that answer, and is it raw web evidence or promoted web memory?' },
      { id: 'T4.4', prompt: 'If the web is unavailable, say so directly and do not guess. What is the latest Ethereum price right now?' },
    ],
  },
  {
    id: 'G5',
    title: 'bounded discovery',
    session: 'discovery',
    tests: [
      { id: 'T5.1', prompt: 'I am working on CognitiveRAG/OpenClaw memory. What else matters here that I am not asking about? Keep it bounded. Give me at most 5 discoveries and label contradictions or unresolved questions explicitly.' },
      { id: 'T5.2', prompt: 'Which of those branches looks weakest, and what alternative branch would you explore instead?' },
      { id: 'T5.3', prompt: 'For this topic, which evidence sources would you check next: session memory, promoted memory, corpus, or web? Explain briefly.' },
      { id: 'T5.4', prompt: 'What contradictions do you currently see in your findings? If none, say none.' },
    ],
  },
  {
    id: 'G6',
    title: 'skill-memory script generation',
    session: 'skill_script',
    tests: [
      { id: 'T6.1', prompt: 'Write a 30-second recipe short about leftover chicken.' },
      { id: 'T6.2', prompt: 'Now explain which principles, templates, examples, rubrics, anti-patterns, or workflows you used.' },
      { id: 'T6.3', prompt: 'What source class did that answer rely on most: skill memory, corpus, general model knowledge, or something else?' },
      { id: 'T6.4', prompt: 'Give me a second variant optimized for stronger hook retention.' },
    ],
  },
  {
    id: 'G7',
    title: 'skill-memory storyboard',
    session: 'skill_storyboard',
    tests: [
      { id: 'T7.1', prompt: 'Now give me a storyboard for it.' },
      { id: 'T7.2', prompt: 'Explain which principles/templates/examples/rubric/anti-patterns you used for the storyboard.' },
      { id: 'T7.3', prompt: 'What anti-patterns did you try to avoid in that storyboard?' },
    ],
  },
  {
    id: 'G8',
    title: 'execution memory',
    session: 'skill_storyboard',
    tests: [
      { id: 'T8.1', prompt: 'Did you store an execution case for the previous run? If yes, show the execution case ID.' },
      { id: 'T8.2', prompt: 'What artifacts were used in that execution case?' },
      { id: 'T8.3', prompt: 'Show me a similar prior execution case if one exists.' },
      { id: 'T8.4', prompt: 'Why is that prior execution case similar?' },
    ],
  },
  {
    id: 'G9',
    title: 'evaluation memory',
    session: 'skill_storyboard',
    tests: [
      { id: 'T9.1', prompt: 'Score the previous output with a rubric and list top improvements.' },
      { id: 'T9.2', prompt: 'Did you store an evaluation case for that? If yes, show the evaluation case ID.' },
      { id: 'T9.3', prompt: 'What were the main weaknesses and anti-pattern hits?' },
      { id: 'T9.4', prompt: 'Show me the strongest prior evaluation for a similar task if one exists.' },
    ],
  },
  {
    id: 'G10',
    title: 'remember vs know vs corpus',
    session: 'knowledge_split',
    tests: [
      { id: 'T10.1', prompt: 'What do you remember about copywriting?' },
      { id: 'T10.2', prompt: 'What do you know about copywriting?' },
      { id: 'T10.3', prompt: 'What do you know from corpus about copywriting?' },
      { id: 'T10.4', prompt: 'What do you know from promoted memory about me?' },
    ],
  },
  {
    id: 'G11',
    title: 'noise suppression',
    session: 'noise',
    tests: [
      { id: 'T11.1', prompt: 'What do you remember?' },
      { id: 'T11.2', prompt: 'Show me only meaningful durable facts, not internal tokens or raw tool errors.' },
      { id: 'T11.3', prompt: 'If you have opaque validation tokens, do not show them unless I explicitly ask. What do you remember now?' },
    ],
  },
  {
    id: 'G12',
    title: 'failure handling',
    session: 'failure',
    tests: [
      { id: 'T12.1', prompt: 'If one source fails, do not crash. Give the best truthful answer you can. What is the latest Bitcoin price right now?' },
      { id: 'T12.2', prompt: 'Summarize what we have already concluded about promoted memory influence on final answers.' },
      { id: 'T12.3', prompt: 'What can you not verify right now?' },
    ],
  },
];

function callGateway(method, params, rawFile) {
  let raw = '';
  const attempts = 4;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      raw = execFileSync('openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params)], {
        encoding: 'utf8',
        timeout: 20000,
      });
      break;
    } catch (error) {
      if (!isRetryableGatewayError(error) || i === attempts) throw error;
      sleepMs(800 * i);
    }
  }
  if (rawFile) fs.writeFileSync(rawFile, raw);
  return safeParseGatewayJson(raw);
}

function createSession(key, label, artifactsDir, idx) {
  return callGateway('sessions.create', { key, label }, path.join(artifactsDir, `${String(idx).padStart(3, '0')}_sessions.create.raw`));
}

function getSession(key, artifactsDir, idx) {
  return callGateway('sessions.get', { key }, path.join(artifactsDir, `${String(idx).padStart(3, '0')}_sessions.get.raw`));
}

function sendPrompt(key, prompt, artifactsDir, idx) {
  return callGateway('sessions.send', { key, message: prompt }, path.join(artifactsDir, `${String(idx).padStart(3, '0')}_sessions.send.raw`));
}

function countAssistant(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => String(m?.role ?? '').toLowerCase() === 'assistant' && extractMessageText(m)).length;
}

function lastAssistantText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (String(m?.role ?? '').toLowerCase() !== 'assistant') continue;
    const t = extractMessageText(m);
    if (t) return t;
  }
  return '';
}

function runPrompt(key, prompt, artifactsDir, idx, timeoutMs = 18000) {
  const before = getSession(key, artifactsDir, idx);
  const beforeAssistant = countAssistant(before?.messages);
  sendPrompt(key, prompt, artifactsDir, idx + 1);
  let latest = before;
  const attempts = Math.max(1, Math.floor(timeoutMs / 3000));
  for (let i = 0; i < attempts; i += 1) {
    sleepMs(2400);
    latest = getSession(key, artifactsDir, idx + 2 + i);
    const afterAssistant = countAssistant(latest?.messages);
    if (afterAssistant > beforeAssistant) {
      return { text: lastAssistantText(latest?.messages), session: latest, timedOut: false };
    }
  }
  return { text: lastAssistantText(latest?.messages), session: latest, timedOut: true };
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# Live OpenClaw Agent Acceptance Report');
  lines.push('');
  lines.push(`- stamp: ${summary.stamp}`);
  lines.push(`- overall score: ${summary.totalScore}/${summary.totalMax}`);
  lines.push(`- critical hard fails: ${summary.criticalFailures.length}`);
  lines.push(`- critical ids: ${summary.criticalFailures.map((f) => f.id).join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Group Summary');
  lines.push('');
  lines.push('| Group | Score | Max | Fails |');
  lines.push('|---|---:|---:|---:|');
  for (const g of summary.groups) {
    lines.push(`| ${g.id} ${g.title} | ${g.score} | ${g.max} | ${g.fails} |`);
  }
  lines.push('');
  lines.push('## Critical Failures');
  lines.push('');
  if (!summary.criticalFailures.length) {
    lines.push('- none');
  } else {
    for (const f of summary.criticalFailures) {
      lines.push(`- ${f.id}: ${f.reason}`);
    }
  }
  lines.push('');
  lines.push('## Test Results');
  lines.push('');
  for (const t of summary.tests) {
    lines.push(`### ${t.id} (${t.group}) score=${t.score}/2`);
    lines.push(`- reason: ${t.reason}`);
    lines.push('- prompt:');
    lines.push('```text');
    lines.push(t.prompt);
    lines.push('```');
    lines.push('- response excerpt:');
    lines.push('```text');
    lines.push(String(t.response || '').slice(0, 900));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function runDirectPersistenceChecks(ctx, reportDir) {
  const checks = [];
  const base = 'http://127.0.0.1:8000';

  const runCurl = (url) => {
    try {
      const out = execFileSync('curl', ['-sS', url], { encoding: 'utf8' });
      return JSON.parse(out);
    } catch {
      return null;
    }
  };

  if (ctx.lastExecutionId) {
    const data = runCurl(`${base}/skill_memory/execution_case/${encodeURIComponent(ctx.lastExecutionId)}`);
    const ok = !!data && String(data.execution_case_id || '') === String(ctx.lastExecutionId);
    checks.push({
      id: 'T15.1',
      group: 'G15',
      prompt: `GET execution case by id ${ctx.lastExecutionId}`,
      response: ok ? 'ok' : 'failed',
      ...scoreById('T15.1', ok ? 'ok' : '', ctx),
    });
  }

  if (ctx.lastExecutionId) {
    const data = runCurl(`${base}/skill_memory/execution_similar?query=storyboard&limit=3`);
    const ok = !!data && Array.isArray(data.items);
    checks.push({
      id: 'T15.2',
      group: 'G15',
      prompt: 'GET similar execution retrieval',
      response: ok ? 'ok' : 'failed',
      ...scoreById('T15.2', ok ? 'ok' : '', ctx),
    });
  }

  if (ctx.lastExecutionId) {
    const data = runCurl(`${base}/skill_memory/evaluations?execution_case_id=${encodeURIComponent(ctx.lastExecutionId)}&limit=3`);
    const ok = !!data && Array.isArray(data.items);
    checks.push({
      id: 'T15.3',
      group: 'G15',
      prompt: `GET evaluations by execution_case_id ${ctx.lastExecutionId}`,
      response: ok ? 'ok' : 'failed',
      ...scoreById('T15.3', ok ? 'ok' : '', ctx),
    });
  }

  fs.writeFileSync(path.join(reportDir, 'direct_persistence_checks.json'), JSON.stringify(checks, null, 2));
  return checks;
}

function run() {
  const stamp = process.argv[2] || `${nowStamp()}-live-acceptance`;
  const repoRoot = '/home/ictin_claw/.openclaw/workspace/openclaw-cognitiverag-memory';
  const reportDir = path.join(repoRoot, 'forensics', 'live_acceptance_reports', stamp);
  ensureDir(reportDir);

  const ctx = {
    executionIds: [],
    evaluationIds: [],
    lastExecutionId: '',
    lastEvaluationId: '',
  };

  const tests = [];
  let callIdx = 1;
  const sessionKeys = new Map();
  const groupFilterEnv = String(process.env.LIVE_ACCEPTANCE_GROUPS ?? '').trim();
  const selectedGroups = new Set(
    groupFilterEnv
      ? groupFilterEnv
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : ['ALL'],
  );
  const wantsGroup = (groupId) => selectedGroups.has('ALL') || selectedGroups.has(groupId);
  const selectedGroupList = Array.from(selectedGroups.values());
  const gitSha = execSync('git rev-parse HEAD', {
    cwd: repoRoot,
    stdio: 'pipe',
    shell: '/bin/bash',
    encoding: 'utf8',
  }).trim();

  const makeSessionKey = (name, agent = 'main') => `agent:${agent}:live-acceptance:${name}:${Date.now()}`;

  const getOrCreate = (sessionName, agent = 'main') => {
    const mapKey = `${agent}:${sessionName}`;
    if (sessionKeys.has(mapKey)) return sessionKeys.get(mapKey);
    const key = makeSessionKey(sessionName, agent);
    createSession(key, `Live acceptance ${sessionName} ${Date.now()}`, reportDir, callIdx++);
    sessionKeys.set(mapKey, key);
    return key;
  };

  const timeoutFor = (testId, groupId) => {
    if (String(groupId) === 'G4') return 90000;
    if (String(groupId) === 'G12') return 90000;
    if (String(testId).startsWith('T14.')) return 30000;
    return 22000;
  };

  for (const group of GROUPS) {
    if (!wantsGroup(group.id)) continue;
    const key = getOrCreate(group.session, 'main');
    for (const test of group.tests) {
      const result = runPrompt(key, test.prompt, reportDir, callIdx, timeoutFor(test.id, group.id));
      callIdx += 3;
      const response = String(result.text || '');
      updateIdsFromText(ctx, response);
      const scoreObj = scoreById(test.id, response, ctx);
      tests.push({
        id: test.id,
        group: group.id,
        groupTitle: group.title,
        prompt: test.prompt,
        response,
        score: scoreObj.score,
        reason: result.timedOut ? `${scoreObj.reason}; timeout` : scoreObj.reason,
        critical: CRITICAL.has(test.id),
        timedOut: !!result.timedOut,
      });
    }
  }

  // Group 13 (cross-model robustness)
  const crossPrompts = [
    { id: 'T13.1', prompt: 'What do you remember about NLP hypnosis?' },
    { id: 'T13.2', prompt: 'Write a 30-second recipe short about leftover chicken.' },
    { id: 'T13.3', prompt: 'Now explain which principles/templates/examples/rubric/anti-patterns you used.' },
  ];
  if (wantsGroup('G13')) {
    const weakKey = getOrCreate('cross_model_weak', 'main');
    for (const test of crossPrompts) {
      const r = runPrompt(weakKey, test.prompt, reportDir, callIdx, 18000);
      callIdx += 3;
      updateIdsFromText(ctx, r.text);
      const s = scoreById(test.id, r.text, ctx);
      tests.push({ id: test.id, group: 'G13', groupTitle: 'cross-model robustness', prompt: `${test.prompt} [weak/default]`, response: r.text, score: s.score, reason: s.reason, critical: false, timedOut: !!r.timedOut });
    }

    try {
      const strongKey = getOrCreate('cross_model_strong', 'codex');
      for (const test of crossPrompts) {
        const r = runPrompt(strongKey, test.prompt, reportDir, callIdx, 18000);
        callIdx += 3;
        updateIdsFromText(ctx, r.text);
        const s = scoreById(test.id, r.text, ctx);
        tests.push({ id: `${test.id}.strong`, group: 'G13', groupTitle: 'cross-model robustness', prompt: `${test.prompt} [strong/codex]`, response: r.text, score: s.score, reason: s.reason, critical: false, timedOut: !!r.timedOut });
      }
    } catch (e) {
      for (const test of crossPrompts) {
        tests.push({
          id: `${test.id}.strong`,
          group: 'G13',
          groupTitle: 'cross-model robustness',
          prompt: `${test.prompt} [strong/codex]`,
          response: 'strong model route unavailable in this runtime',
          score: 1,
          reason: 'strong model route unavailable; recorded as partial',
          critical: false,
          timedOut: false,
        });
      }
    }
  }

  // Group 14 restart persistence
  const restartTests = [
    { id: 'T14.1', prompt: '/crag_status' },
    { id: 'T14.2', prompt: '/crag_explain_memory' },
    { id: 'T14.3', prompt: 'What do you remember about copywriting?' },
    { id: 'T14.4', prompt: 'Show me a prior execution case for a recipe short if one exists.' },
  ];
  if (wantsGroup('G14')) {
    execSync('openclaw gateway restart', { stdio: 'pipe', shell: '/bin/bash' });
    sleepMs(2200);
    const restartKey = getOrCreate('post_restart', 'main');
    for (const test of restartTests) {
      const r = runPrompt(restartKey, test.prompt, reportDir, callIdx, timeoutFor(test.id, 'G14'));
      callIdx += 3;
      updateIdsFromText(ctx, r.text);
      const s = scoreById(test.id, r.text, ctx);
      tests.push({ id: test.id, group: 'G14', groupTitle: 'restart persistence', prompt: test.prompt, response: r.text, score: s.score, reason: s.reason, critical: CRITICAL.has(test.id), timedOut: !!r.timedOut });
    }
  }

  // Group 15 optional direct persistence checks
  if (wantsGroup('G15')) tests.push(...runDirectPersistenceChecks(ctx, reportDir));

  const groupMap = groupBy(tests, (t) => t.group);
  const groups = Array.from(groupMap.entries())
    .map(([groupId, arr]) => {
      const title = String(arr[0]?.groupTitle ?? groupId);
      const score = arr.reduce((n, t) => n + Number(t.score || 0), 0);
      const max = arr.length * 2;
      const fails = arr.filter((t) => Number(t.score || 0) === 0).length;
      return { id: groupId, title, score, max, fails };
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const criticalFailures = tests.filter((t) => t.critical && Number(t.score) === 0).map((t) => ({ id: t.id, reason: t.reason }));
  const totalScore = tests.reduce((n, t) => n + Number(t.score || 0), 0);
  const totalMax = tests.length * 2;

  const summary = {
    stamp,
    generatedAt: new Date().toISOString(),
    reportDir,
    codeState: {
      gitSha,
      selectedGroups: selectedGroupList,
    },
    totalScore,
    totalMax,
    criticalFailures,
    contextIds: {
      executionIds: ctx.executionIds,
      evaluationIds: ctx.evaluationIds,
      lastExecutionId: ctx.lastExecutionId,
      lastEvaluationId: ctx.lastEvaluationId,
    },
    groups,
    tests,
  };

  fs.writeFileSync(path.join(reportDir, 'live_acceptance_results.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(reportDir, 'live_acceptance_report.md'), renderMarkdown(summary));
  fs.writeFileSync(path.join(repoRoot, 'forensics', '.latest_live_acceptance_report'), reportDir + '\n');

  const hasCriticalHardFail = criticalFailures.length > 0;
  console.log(JSON.stringify({
    stamp,
    reportDir,
    totalScore,
    totalMax,
    criticalHardFailCount: criticalFailures.length,
    criticalHardFails: criticalFailures,
  }, null, 2));

  if (hasCriticalHardFail) process.exitCode = 2;
}

run();
