#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

const runtimeFile = process.env.OPENCLAW_RUNTIME_FILE || '/home/ictin_claw/.npm-global/lib/node_modules/openclaw/dist/pi-embedded-CbCYZxIb.js';
if (!fs.existsSync(runtimeFile)) {
  console.error(`[runtime-patch] runtime file not found: ${runtimeFile}`);
  process.exit(1);
}

const text = fs.readFileSync(runtimeFile, 'utf8');
const checks = [
  {
    name: 'latest user turn is selected for short-circuit candidate',
    ok: text.includes('let userIdx = -1;') && text.includes('if (messages[i]?.role === "user") {')
  },
  {
    name: 'final answer must exist in latest user message',
    ok: text.includes('const finalMatch = userText.match(/BEGIN_FINAL_ANSWER') && text.includes('if (!finalMatch?.[1]) return null;')
  },
  {
    name: 'mode marker can be read from user or adjacent previous message',
    ok:
      text.includes('let modeMatch = userText.match(/HARD_SHORT_CIRCUIT_INTENT=(memory_summary|corpus_overview|architecture_overview)/i)') &&
      text.includes('if (!modeMatch?.[1] && userIdx > 0)')
  },
  {
    name: 'short-circuit only applies when source question matches active prompt',
    ok:
      text.includes('modeMatch[1].toLowerCase() === "memory_summary" && typeof expectedPrompt === "string" && expectedPrompt.trim()') &&
      text.includes('!expected.includes(sourceQuestion)') &&
      text.includes('!sourceQuestion.includes(expected)')
  },
  {
    name: 'runtime accepts architecture_overview deterministic mode',
    ok: text.includes('architecture_overview')
  },
  {
    name: 'runtime applies deterministic short-circuit for architecture_overview mode',
    ok:
      text.includes('deterministicShortCircuit.mode === "memory_summary"') &&
      text.includes('deterministicShortCircuit.mode === "corpus_overview"') &&
      text.includes('deterministicShortCircuit.mode === "architecture_overview"')
  },
  {
    name: 'runtime calls short-circuit resolver with effective prompt',
    ok: text.includes('resolveDeterministicShortCircuitFromMessages(activeSession.messages, effectivePrompt)')
  },
  {
    name: 'runtime emits deterministic short-circuit marker log',
    ok: text.includes('context engine deterministic short-circuit applied')
  },
  {
    name: 'runtime rewrites raw provider bad-request payloads to graceful copy',
    ok:
      text.includes('trimmed === \'{"detail":"Bad Request"}\'') &&
      text.includes('/invalid_request_body/i.test(trimmed)') &&
      text.includes('The upstream model request failed temporarily. Please retry in a few seconds.')
  }
];

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  for (const item of failed) console.error(`[runtime-patch] FAIL: ${item.name}`);
  process.exit(2);
}
for (const item of checks) console.log(`[runtime-patch] OK: ${item.name}`);
