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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-explain-backend-contract-'));
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

const explain = regs.commands.find((c) => c?.name === 'crag_explain_memory');
assert.ok(explain && typeof explain.handler === 'function', 'crag_explain_memory command should register');

const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/session_assemble_context')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    assert.equal(body.intent_family, 'architecture_explanation');
    return makeFetchResponse(200, {
      fresh_tail: [],
      summaries: [],
      explanation: {
        intent_family: 'architecture_explanation',
        total_budget: 512,
        reserved_tokens: 128,
        selected_blocks: [{ id: 's1', lane: 'promoted', memory_type: 'promoted_fact', tokens: 44, utility: 0.9 }],
        dropped_blocks: [],
        lane_totals: { promoted: 44, episodic: 20 },
        cluster_coverage: ['architecture'],
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
  const out = await explain.handler({});
  const text = String(out?.text ?? '');
  assert.match(text, /runtime entry path:\s*.*index\.ts/i);
  assert.match(text, /runtime plugin root:\s*.+/i);
  assert.match(text, /backend selector explanation:\s*valid/i);
  assert.match(text, /selector intent family:\s*architecture_explanation/i);
  assert.match(text, /promoted:\s*44/i);
} finally {
  global.fetch = realFetch;
}

console.log('crag explain memory backend contract test passed');
