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

// CASE C: malformed backend body (string)
const malformed = { status: 200, body: "I am not an object" };
const shapedC = shapeAssembleResponse(malformed, 1024);
const resC = toEngineAssembleResult(shapedC);
assert(Array.isArray(resC.messages));
assert(resC.messages.length === 0, 'malformed body should yield no messages');
assert(Number.isFinite(resC.estimatedTokens) && resC.estimatedTokens >= 0);
assert(Number.isFinite(resC.totalTokens) && resC.totalTokens >= 0);

// CASE D: null backend body
const nulled = { status: 200, body: null };
const shapedD = shapeAssembleResponse(nulled, 1024);
const resD = toEngineAssembleResult(shapedD);
assert(Array.isArray(resD.messages));
assert(resD.messages.length === 0, 'null body should yield no messages');
assert(Number.isFinite(resD.estimatedTokens) && resD.estimatedTokens >= 0);
assert(Number.isFinite(resD.totalTokens) && resD.totalTokens >= 0);

// CASE E: missing body fields
const missingFields = { status: 200, body: {} };
const shapedE = shapeAssembleResponse(missingFields, 2048);
const resE = toEngineAssembleResult(shapedE);
assert(Array.isArray(resE.messages));
assert(resE.messages.length === 0, 'missing fields should yield no messages');
assert(Number.isFinite(resE.estimatedTokens) && resE.estimatedTokens >= 0);
assert(Number.isFinite(resE.totalTokens) && resE.totalTokens >= 0);

console.log('assemble tests passed');
