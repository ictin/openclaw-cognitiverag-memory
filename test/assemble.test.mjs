import assert from "assert";
import { shapeAssembleResponse, toEngineAssembleResult } from "../index.js";

// CASE A: empty backend
const empty = { status: 200, body: { fresh_tail: [], summaries: [] } };
const shapedA = shapeAssembleResponse(empty, 4096);
const resA = toEngineAssembleResult(shapedA);
assert(Array.isArray(resA.messages));
assert(Number.isFinite(resA.estimatedTokens));
assert(Number.isFinite(resA.totalTokens));

// CASE B: fresh tail + summaries
const b = { status: 200, body: { fresh_tail: [{ sender: 'user', text: 'Hello' }, { sender: 'assistant', text: 'Hi' }], summaries: [{ summary: 'older' }] } };
const shapedB = shapeAssembleResponse(b, 4096);
const resB = toEngineAssembleResult(shapedB);
assert(Array.isArray(resB.messages) && resB.messages.length === 2);
assert(Number.isFinite(resB.estimatedTokens) && resB.estimatedTokens >= 0);
assert(Number.isFinite(resB.totalTokens) && resB.totalTokens >= 0);
console.log('assemble tests passed');
