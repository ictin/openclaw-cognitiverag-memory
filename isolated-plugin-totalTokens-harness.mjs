import assert from "node:assert/strict";
import { toEngineAssembleResult } from "./index.ts";

const normalized = toEngineAssembleResult({
  messages: [{ role: "user", content: "hello" }],
  estimatedTokens: 37,
});

assert.equal(normalized.estimatedTokens, 37);
assert.equal(normalized.totalTokens, 37);

console.log("isolated plugin totalTokens harness ok");
