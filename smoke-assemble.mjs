import assert from 'node:assert/strict';
import { shapeAssembleResponse } from './index.ts';

if (import.meta.url === `file://${process.argv[1]}`) {
const structured = shapeAssembleResponse({
  body: {
    context_block: {
      provenance: 'ctx-provenance',
      exact_items: [{ content: 'exact A', item_type: 'x', exactness: 'exact', summarizable: false }],
      derived_items: [{ summary: 'derived B', item_type: 'y', summarizable: true }],
    },
    fresh_tail: [{ sender: 'assistant', text: 'fallback nope' }],
    summaries: [{ summary: 'summary nope' }],
  },
});
assert.equal(structured.messages.length, 2);
assert.equal(structured.messages[0].metadata.provenance, 'ctx-provenance');
assert.equal(structured.systemPromptAddition, undefined);

const fallback = shapeAssembleResponse({
  body: {
    fresh_tail: [{ sender: 'assistant', text: 'hello' }, { sender: 'user', text: 'world' }],
    summaries: [{ summary: 'old summary' }],
  },
});
assert.deepEqual(fallback.messages, [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'world' }]);
assert.match(fallback.systemPromptAddition, /old summary/);

console.log('mock assemble smoke ok');
}
