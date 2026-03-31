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

function installFetchMock() {
  const sessions = new Map();
  const writes = { execution: [], evaluation: [] };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/session_append_message')) {
      const sessionId = String(body?.session_id ?? '');
      const arr = sessions.get(sessionId) ?? [];
      arr.push({ sender: String(body?.sender ?? 'user'), text: String(body?.text ?? '') });
      sessions.set(sessionId, arr);
      return makeFetchResponse(200, { status: 'inserted' });
    }
    if (u.endsWith('/session_append_message_part')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_upsert_context_item')) return makeFetchResponse(200, { status: 'inserted' });
    if (u.endsWith('/session_assemble_context')) {
      const sessionId = String(body?.session_id ?? '');
      const freshTail = sessionId === '__crag_probe__' ? [] : (sessions.get(sessionId) ?? []).slice(-20);
      return makeFetchResponse(200, { fresh_tail: freshTail, summaries: [] });
    }
    if (u.endsWith('/skill_memory/build_pack')) {
      const agent = String(body?.agent_type ?? 'script_agent');
      return makeFetchResponse(200, {
        query: String(body?.query ?? ''),
        agent_type: agent,
        task_type: String(body?.task_type ?? ''),
        selected_artifact_ids: ['skill:principle:1', 'skill:template:1', 'skill:example:1'],
        grouped_artifacts: {
          principle: [{ canonical_text: `${agent} principle: open with concrete payoff.` }],
          template: [{ canonical_text: `Template: {hook} -> {steps} -> {payoff}` }],
          example: [{ canonical_text: 'Example: Before weak opening, after concrete promise.' }],
          rubric: [{ canonical_text: 'Rubric: hook clarity; pacing; payoff; CTA' }],
          anti_pattern: [{ canonical_text: 'Anti-pattern: vague intro.' }],
          workflow: [{ canonical_text: 'Workflow: ideate -> draft -> revise' }],
        },
        warnings: [],
      });
    }
    if (u.endsWith('/skill_memory/execution_case')) {
      writes.execution.push(body);
      return makeFetchResponse(200, { status: 'ok', execution_case_id: 'exec:test-1' });
    }
    if (u.endsWith('/skill_memory/evaluation_case')) {
      writes.evaluation.push(body);
      return makeFetchResponse(200, { status: 'ok', evaluation_case_id: 'eval:test-1' });
    }
    throw new Error(`unexpected fetch URL: ${u}`);
  };
  return {
    writes,
    restore() {
      global.fetch = realFetch;
    },
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crag-skill-memory-integration-'));
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
assert.ok(engine, 'context engine should register');

const mock = installFetchMock();
const sessionId = 'skill-memory-int-session';

const script = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:skill-memory-int',
  prompt: 'Write a 30-second recipe short about leftover chicken.',
  messages: [{ role: 'user', content: 'Write a 30-second recipe short about leftover chicken.' }],
  tokenBudget: 4096,
});
assert.match(JSON.stringify(script?.messages ?? []), /HARD_SHORT_CIRCUIT_INTENT=architecture_overview/i);
assert.match(JSON.stringify(script?.messages ?? []), /Skill artifacts applied:/i);
assert.match(JSON.stringify(script?.messages ?? []), /Execution memory write: saved \(exec:test-1\)/i);
assert.equal(mock.writes.execution.length, 1, 'execution case should be written');

const explain = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:skill-memory-int',
  prompt: 'Explain which principles/templates/examples/rubric/anti-patterns you used.',
  messages: [{ role: 'user', content: 'Explain which principles/templates/examples/rubric/anti-patterns you used.' }],
  tokenBudget: 4096,
});
assert.match(JSON.stringify(explain?.messages ?? []), /Skill-memory usage for execution case exec:test-1/i);
assert.match(JSON.stringify(explain?.messages ?? []), /principle:/i);

const evaluation = await engine.assemble({
  sessionId,
  sessionKey: 'agent:main:skill-memory-int',
  prompt: 'Score this output with a rubric.',
  messages: [{ role: 'user', content: 'Score this output with a rubric.' }],
  tokenBudget: 4096,
});
assert.match(JSON.stringify(evaluation?.messages ?? []), /Rubric evaluation for execution exec:test-1/i);
assert.match(JSON.stringify(evaluation?.messages ?? []), /Evaluation memory write: saved \(eval:test-1\)/i);
assert.equal(mock.writes.evaluation.length, 1, 'evaluation case should be written');

mock.restore();
console.log('plugin skill-memory integration test passed');

