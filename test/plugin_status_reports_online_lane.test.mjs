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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-status-online-lane-'));
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

const statusCmd = regs.commands.find((c) => c?.name === 'crag_status');
assert.ok(statusCmd && typeof statusCmd.handler === 'function', 'crag_status should register');

const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.endsWith('/session_assemble_context')) throw new Error(`unexpected URL: ${u}`);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (body.session_id === '__crag_probe__') {
    return makeFetchResponse(200, { fresh_tail: [], summaries: [] });
  }
  if (body.session_id === '__crag_online_probe__') {
    return makeFetchResponse(200, {
      fresh_tail: [],
      summaries: [],
      explanation: {
        intent_family: 'investigative',
        total_budget: 512,
        reserved_tokens: 120,
        selected_blocks: [
          { id: 'w1', lane: 'web', memory_type: 'web_evidence', tokens: 88, utility: 0.8 },
          { id: 'w2', lane: 'web', memory_type: 'web_promoted_fact', tokens: 44, utility: 0.7 },
        ],
        dropped_blocks: [],
        lane_totals: { web: 132 },
        cluster_coverage: [],
        reorder_strategy: 'front_back_anchor',
      },
    });
  }
  return makeFetchResponse(200, { fresh_tail: [], summaries: [] });
};

try {
  const out = await statusCmd.handler({});
  const text = String(out?.text ?? '');
  assert.match(text, /runtime entry path:\s*.*index\.ts/i);
  assert.match(text, /runtime plugin root:\s*.+/i);
  assert.match(text, /online lane status:\s*enabled/i);
  assert.match(text, /online source classes:\s*web evidence, web promoted/i);
} finally {
  global.fetch = realFetch;
}

console.log('plugin status reports online lane test passed');
