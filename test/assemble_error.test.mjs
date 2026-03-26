import assert from 'assert';
import register, { toEngineAssembleResult } from '../index.js';
import fs from 'node:fs';

let regs = { commands: [], routes: [], contextEngines: {} };
const api = {
  registerCommand: (c) => regs.commands.push(c.name),
  registerHttpRoute: (r) => regs.routes.push(r.path),
  registerContextEngine: (id, f) => { regs.contextEngines[id] = f(); },
  config: { plugins: { slots: { contextEngine: 'test' } } },
};
register(api);
const engine = regs.contextEngines['cognitiverag-memory'];
assert(engine, 'engine registered');

// Monkeypatch fetch to throw to simulate backend error/throw path
const realFetch = global.fetch;
global.fetch = async () => { throw new Error('simulated backend failure'); };

const inputMessages = [{ role: 'user', content: 'Hello' }];
const result = await engine.assemble({ sessionId: 'sess-err', messages: inputMessages });

assert(Array.isArray(result.messages), 'messages array present');
assert(result.messages.length === inputMessages.length, 'messages preserved on error');
assert(result.estimatedTokens === 0, 'estimatedTokens zero on error');
assert(result.totalTokens === 0, 'totalTokens zero on error');

// restore fetch
global.fetch = realFetch;
console.log('assemble error-path test passed');
