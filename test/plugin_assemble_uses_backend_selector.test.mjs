import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import register from '../index.js';

function makeFetchResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-plugin-assemble-backend-selector-'));
const regs = { commands: [], engines: {} };
const api = {
  source: path.join(tmpDir, 'index.ts'),
  registerCommand: (cmd) => regs.commands.push(cmd),
  registerHttpRoute: () => {},
  registerContextEngine: (id, factory) => {
    regs.engines[id] = factory();
  },
  config: { plugins: { slots: { contextEngine: 'cognitiverag-memory' } } },
  logger: { info: () => {}, warn: () => {} },
};
register(api);

const engine = regs.engines['cognitiverag-memory'];
assert.ok(engine && typeof engine.assemble === 'function');

let seenAssembleRequest = null;
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (u.endsWith('/session_assemble_context')) {
    seenAssembleRequest = body;
    return makeFetchResponse(200, {
      fresh_tail: [{ sender: 'user', text: 'Earlier detailA was discussed.' }],
      summaries: [{ summary: 'Older summary line.' }],
      explanation: {
        intent_family: 'exact_recall',
        total_budget: 4096,
        reserved_tokens: 420,
        selected_blocks: [
          {
            id: 'episodic:1',
            lane: 'episodic',
            memory_type: 'episodic_raw',
            tokens: 50,
            utility: 0.91,
            provenance: { session_id: 'sess' },
          },
        ],
        dropped_blocks: [],
        lane_totals: { episodic: 50, promoted: 18 },
        cluster_coverage: ['session_history'],
        reorder_strategy: 'front_back_anchor',
      },
    });
  }
  if (u.endsWith('/session_append_message')) return makeFetchResponse(200, { status: 'inserted' });
  if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
  if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
  throw new Error(`unexpected fetch URL: ${u}`);
};

try {
  const out = await engine.assemble({
    sessionId: 'sess',
    sessionKey: 'agent:main:selector',
    prompt: 'What did we say earlier about detailA?',
    messages: [{ role: 'user', content: 'What did we say earlier about detailA?' }],
    tokenBudget: 4096,
  });
  assert.ok(seenAssembleRequest, 'assemble backend request should be sent');
  assert.equal(seenAssembleRequest.query, 'What did we say earlier about detailA?');
  assert.equal(seenAssembleRequest.intent_family, 'exact_recall');
  const prompt = String(out?.systemPromptAddition ?? '');
  assert.match(prompt, /Backend selector explanation \(authoritative\):/i);
  assert.match(prompt, /intent_family:\s*exact_recall/i);
  assert.match(prompt, /lane totals:/i);
} finally {
  global.fetch = realFetch;
}

console.log('plugin assemble uses backend selector test passed');

