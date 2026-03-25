import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const blockStart = source.indexOf("        const freshTail = Array.isArray(assemblyRes?.body?.fresh_tail)");
const blockEnd = source.indexOf("        const estimatedTokens = Math.max(", blockStart);
assert.ok(blockStart >= 0, "assemble block start not found");
assert.ok(blockEnd > blockStart, "assemble block end not found");
const block = source.slice(blockStart, blockEnd);

const markers = [
  "const freshTail = Array.isArray(assemblyRes?.body?.fresh_tail)",
  "const summaries = Array.isArray(assemblyRes?.body?.summaries)",
  "const contextBlock = assemblyRes?.body?.context_block",
  "exact_items",
  "derived_items",
  "provenance",
  "structuredContextMessages",
  "freshTail",
  "summaries",
  "systemPromptAddition",
];
for (const marker of markers) {
  assert.ok(block.includes(marker), `missing marker: ${marker}`);
}

assert.ok(block.includes("item?.provenance ?? contextProvenance ?? null") || block.includes("contextProvenance ?? null"), "missing provenance carry-forward");
assert.ok(block.includes("structuredContextMessages.length ? structuredContextMessages : freshTail") || block.includes("structuredContextMessages.length\n          ? structuredContextMessages\n          : freshTail"), "missing structured fallback path");
assert.ok(block.includes("structuredContextMessages.length\n          ? derivedContextItems") || block.includes("structuredContextMessages.length ? derivedContextItems"), "missing structured derived summary path");
assert.ok(block.includes(": summaries") || block.includes("summaries\n              .map"), "missing summaries fallback path");

console.log("smoke ok: assemble source prefers context_block markers and preserves fallback markers");
