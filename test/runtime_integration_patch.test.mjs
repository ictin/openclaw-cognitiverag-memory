import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const patchPath = path.join(repoRoot, 'runtime_patches/openclaw/runtime-shortcircuit-intent-bridge.patch');
const applyScriptPath = path.join(repoRoot, 'scripts/apply_openclaw_runtime_patch.mjs');
const verifyScriptPath = path.join(repoRoot, 'scripts/verify_openclaw_runtime_patch.mjs');

assert.ok(existsSync(patchPath), 'runtime patch file should exist');
assert.ok(existsSync(applyScriptPath), 'runtime patch apply script should exist');
assert.ok(existsSync(verifyScriptPath), 'runtime patch verify script should exist');

const patchText = readFileSync(patchPath, 'utf8');
assert.match(
  patchText,
  /DETERMINISTIC_RESPONSE_MODE=\(memory_summary\|corpus_overview\|architecture_overview\)/,
  'runtime patch should include deterministic response mode support',
);
assert.match(
  patchText,
  /let modeMatch = userText\.match\(\/HARD_SHORT_CIRCUIT_INTENT=\(memory_summary\|corpus_overview\|architecture_overview\)\/i\) \|\| userText\.match\(\/DETERMINISTIC_RESPONSE_MODE=\(memory_summary\|corpus_overview\|architecture_overview\)\/i\);/,
  'runtime patch should read mode markers from deterministic user payload first',
);
assert.match(
  patchText,
  /let userIdx = -1;/,
  'runtime patch should select the latest user message for deterministic candidate parsing',
);
assert.match(
  patchText,
  /if \(!modeMatch\?\.\[1\] && userIdx > 0\)/,
  'runtime patch should allow mode marker lookup from adjacent previous message',
);
assert.match(
  patchText,
  /if \(modeMatch\[1\]\.toLowerCase\(\) === "memory_summary" && typeof expectedPrompt === "string" && expectedPrompt\.trim\(\)\)/,
  'runtime patch should gate short-circuit by active prompt matching source question',
);
assert.match(
  patchText,
  /modeMatch\[1\]\.toLowerCase\(\) === "memory_summary"/,
  'runtime patch should enforce strict prompt-match gating for memory_summary only',
);
assert.match(
  patchText,
  /trimmed === '\{\"detail\":\"Bad Request\"\}'/,
  'runtime patch should rewrite raw Bad Request payload to graceful copy',
);
assert.match(
  patchText,
  /invalid_request_body/i,
  'runtime patch should also rewrite invalid_request_body payloads',
);

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function resolveDeterministicShortCircuitFromMessages(messages, expectedPrompt) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role ?? '').toLowerCase() === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;
  const userText = contentToText(messages[userIdx]?.content);
  if (!userText) return null;
  const finalMatch = userText.match(/BEGIN_FINAL_ANSWER\s*([\s\S]*?)\s*END_FINAL_ANSWER/i);
  if (!finalMatch?.[1]) return null;
  const finalAnswer = String(finalMatch[1]).trim();
  if (!finalAnswer) return null;
  let modeMatch =
    userText.match(/HARD_SHORT_CIRCUIT_INTENT=(memory_summary|corpus_overview|architecture_overview)/i) ||
    userText.match(/DETERMINISTIC_RESPONSE_MODE=(memory_summary|corpus_overview|architecture_overview)/i);
  if (!modeMatch?.[1] && userIdx > 0) {
    const prevText = contentToText(messages[userIdx - 1]?.content);
    if (prevText) {
      modeMatch =
        prevText.match(/HARD_SHORT_CIRCUIT_INTENT=(memory_summary|corpus_overview|architecture_overview)/i) ||
        prevText.match(/DETERMINISTIC_RESPONSE_MODE=(memory_summary|corpus_overview|architecture_overview)/i);
    }
  }
  if (!modeMatch?.[1]) return null;
  if (modeMatch[1].toLowerCase() === 'memory_summary' && typeof expectedPrompt === 'string' && expectedPrompt.trim()) {
    const compact = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const expected = compact(expectedPrompt);
    const sourceQuestionMatch = userText.match(/Original user question:\s*([^\n]+)/i);
    const sourceQuestion = compact(sourceQuestionMatch?.[1] ?? '');
    if (!sourceQuestion) return null;
    if (sourceQuestion !== expected && !expected.includes(sourceQuestion) && !sourceQuestion.includes(expected)) return null;
  }
  return { mode: modeMatch[1].toLowerCase(), finalAnswer };
}

{
  const out = resolveDeterministicShortCircuitFromMessages([
    { role: 'system', content: 'HARD_SHORT_CIRCUIT_INTENT=memory_summary' },
    { role: 'user', content: 'Original user question: What do you remember?\nBEGIN_FINAL_ANSWER\nLayered memory summary\nEND_FINAL_ANSWER' },
  ], 'What do you remember?');
  assert.deepEqual(out, { mode: 'memory_summary', finalAnswer: 'Layered memory summary' });
}

{
  const out = resolveDeterministicShortCircuitFromMessages([
    { role: 'user', content: 'Original user question: What can you tell me about youtube secrets?\nDETERMINISTIC_RESPONSE_MODE=corpus_overview\nBEGIN_FINAL_ANSWER\nCorpus-based answer\nEND_FINAL_ANSWER' },
  ], 'What can you tell me about youtube secrets?');
  assert.deepEqual(out, { mode: 'corpus_overview', finalAnswer: 'Corpus-based answer' });
}

{
  const out = resolveDeterministicShortCircuitFromMessages([
    { role: 'user', content: 'Original user question: Do you use CRAG lossless memory?\nDETERMINISTIC_RESPONSE_MODE=architecture_overview\nBEGIN_FINAL_ANSWER\nYes. Layered architecture answer.\nEND_FINAL_ANSWER' },
  ], 'Do you use CRAG lossless memory?');
  assert.deepEqual(out, { mode: 'architecture_overview', finalAnswer: 'Yes. Layered architecture answer.' });
}

{
  const out = resolveDeterministicShortCircuitFromMessages([
    { role: 'system', content: 'HARD_SHORT_CIRCUIT_INTENT=memory_summary' },
    { role: 'assistant', content: 'BEGIN_FINAL_ANSWER\nwrong role\nEND_FINAL_ANSWER' },
  ], 'What do you remember?');
  assert.equal(out, null, 'should not short-circuit when final answer block is missing from user role');
}

{
  const out = resolveDeterministicShortCircuitFromMessages([
    { role: 'system', content: 'HARD_SHORT_CIRCUIT_INTENT=memory_summary' },
    { role: 'user', content: 'Original user question: What do you remember?\nBEGIN_FINAL_ANSWER\nfresh summary\nEND_FINAL_ANSWER' },
    { role: 'assistant', content: 'old deterministic answer' },
    { role: 'user', content: 'normal follow-up without deterministic markers' },
  ], 'What is your status?');
  assert.equal(out, null, 'should not reuse stale deterministic payload from prior turns');
}

console.log('runtime integration patch test passed');
