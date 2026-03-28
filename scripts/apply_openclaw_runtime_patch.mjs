#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const runtimeFile = process.env.OPENCLAW_RUNTIME_FILE || '/home/ictin_claw/.npm-global/lib/node_modules/openclaw/dist/pi-embedded-CbCYZxIb.js';

if (!fs.existsSync(runtimeFile)) {
  console.error(`[runtime-patch] runtime file not found: ${runtimeFile}`);
  process.exit(1);
}

const source = fs.readFileSync(runtimeFile, 'utf8');
const fnRegex = /function resolveDeterministicShortCircuitFromMessages\(messages(?:, expectedPrompt)?\) \{[\s\S]*?\n\}/;
const match = source.match(fnRegex);
if (!match?.[0]) {
  console.error('[runtime-patch] target function not found; runtime build drift detected');
  process.exit(2);
}

const expected = `function resolveDeterministicShortCircuitFromMessages(messages, expectedPrompt) {
\tif (!Array.isArray(messages) || messages.length === 0) return null;
\tlet userIdx = -1;
\tfor (let i = messages.length - 1; i >= 0; i--) {
\t\tif (messages[i]?.role === "user") {
\t\t\tuserIdx = i;
\t\t\tbreak;
\t\t}
\t}
\tif (userIdx < 0) return null;
\tconst userText = contentToText(messages[userIdx]?.content);
\tif (!userText) return null;
\tconst finalMatch = userText.match(/BEGIN_FINAL_ANSWER\\s*([\\s\\S]*?)\\s*END_FINAL_ANSWER/i);
\tif (!finalMatch?.[1]) return null;
\tconst finalAnswer = String(finalMatch[1]).trim();
\tif (!finalAnswer) return null;
\tlet modeMatch = userText.match(/HARD_SHORT_CIRCUIT_INTENT=(memory_summary|corpus_overview)/i) || userText.match(/DETERMINISTIC_RESPONSE_MODE=(memory_summary|corpus_overview)/i);
\tif (!modeMatch?.[1] && userIdx > 0) {
\t\tconst prevText = contentToText(messages[userIdx - 1]?.content);
\t\tif (prevText) modeMatch = prevText.match(/HARD_SHORT_CIRCUIT_INTENT=(memory_summary|corpus_overview)/i) || prevText.match(/DETERMINISTIC_RESPONSE_MODE=(memory_summary|corpus_overview)/i);
\t}
\tif (!modeMatch?.[1]) return null;
\tif (modeMatch[1].toLowerCase() === "memory_summary" && typeof expectedPrompt === "string" && expectedPrompt.trim()) {
\t\tconst compact = (value) => String(value ?? "").toLowerCase().replace(/\\s+/g, " ").trim();
\t\tconst expected = compact(expectedPrompt);
\t\tconst sourceQuestionMatch = userText.match(/Original user question:\\s*([^\\n]+)/i);
\t\tconst sourceQuestion = compact(sourceQuestionMatch?.[1] ?? "");
\t\tif (!sourceQuestion) return null;
\t\tif (sourceQuestion !== expected && !expected.includes(sourceQuestion) && !sourceQuestion.includes(expected)) return null;
\t}
\treturn {
\t\tmode: modeMatch[1].toLowerCase(),
\t\tfinalAnswer
\t};
\treturn null;
}`;

if (match[0] === expected && source.includes('resolveDeterministicShortCircuitFromMessages(activeSession.messages, effectivePrompt)')) {
  console.log('[runtime-patch] already applied');
  process.exit(0);
}

let updated = source.replace(fnRegex, expected);
updated = updated.replace('resolveDeterministicShortCircuitFromMessages(activeSession.messages)', 'resolveDeterministicShortCircuitFromMessages(activeSession.messages, effectivePrompt)');

if (updated === source) {
  console.error('[runtime-patch] no changes applied; runtime build drift detected');
  process.exit(3);
}

fs.writeFileSync(runtimeFile, updated, 'utf8');
console.log(`[runtime-patch] applied to ${runtimeFile}`);
