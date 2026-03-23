import assert from 'node:assert/strict';
import { shapeAssembleResponse } from './index.ts';

function makeAssemblyRes(body) {
  return { status: 200, body };
}

const structured = shapeAssembleResponse(makeAssemblyRes({
  context_block: {
    provenance: 'ctx-provenance',
    exact_items: [
      { content: 'exact A', item_type: 'x', exactness: 'exact', summarizable: false },
    ],
    derived_items: [
      { summary: 'derived B', item_type: 'y', summarizable: true },
    ],
  },
  fresh_tail: [{ sender: 'assistant', text: 'fallback nope' }],
  summaries: [{ summary: 'summary nope' }],
}));
assert.equal(structured.messages.length, 2);
assert.equal(structured.messages[0].metadata.provenance, 'ctx-provenance');
assert.equal(structured.systemPromptAddition, undefined);
assert.ok(structured.estimatedTokens > 0);
assert.equal(structured.totalTokens, structured.estimatedTokens);

const fallback = shapeAssembleResponse(makeAssemblyRes({
  fresh_tail: [
    { sender: 'assistant', text: 'hello' },
    { sender: 'user', text: 'world' },
  ],
  summaries: [{ summary: 'old summary' }],
}));
assert.deepEqual(fallback.messages, [
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'world' },
]);
assert.match(fallback.systemPromptAddition, /old summary/);
assert.ok(fallback.estimatedTokens > 0);
assert.equal(fallback.totalTokens, fallback.estimatedTokens);

console.log('real assemble harness ok');
