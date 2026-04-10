# openclaw-cognitiverag-memory

OpenClaw plugin adapter for CognitiveRAG.

## What This Repository Is

`openclaw-cognitiverag-memory` is the OpenClaw integration layer that wires OpenClaw runtime/plugin surfaces to the CognitiveRAG backend.

This repository is intentionally thin:
- it translates OpenClaw requests to backend calls
- it enforces integration-side fail-closed/fail-open behavior where required by acceptance policy
- it exposes integration diagnostics, live acceptance harnesses, and contract checks

## What Problem It Solves

Without this adapter, OpenClaw cannot reliably consume CognitiveRAG capabilities (context assembly, memory explanation surfaces, promoted-memory traces, runtime status) through stable plugin/runtime contracts.

This repo provides that contract-safe bridge and test harnesses for live signoff.

## Current Feature Set

- OpenClaw plugin entrypoint (`index.ts`) with command/route integration
- Backend client wiring and contract validation
- Assembly integration path checks and error-shape enforcement
- Runtime integration patch tooling (`scripts/apply_openclaw_runtime_patch.mjs`, `scripts/verify_openclaw_runtime_patch.mjs`)
- Live acceptance runners and closure aggregator:
  - `scripts/run_live_agent_acceptance.mjs`
  - `scripts/run_live_agent_acceptance_closure.mjs`
  - `scripts/score_live_agent_acceptance.mjs`
- Regression tests for routing, source/truthfulness wording, status/explain-memory surfaces, and runtime integration

## What It Does NOT Own

This repository does **not** own backend intelligence. It does not own:
- retrieval strategy
- memory policy
- candidate scoring policy
- contradiction/compatibility reasoning
- long-context selection strategy

Those belong to the CognitiveRAG backend repository.

## Architecture

High-level flow:
1. OpenClaw invokes plugin surfaces (commands/hooks/routes/context engine integration surface).
2. Plugin integration code validates/normalizes request shape.
3. Plugin calls CognitiveRAG backend APIs.
4. Plugin returns integration-safe, policy-compliant responses to OpenClaw.

Key modules:
- `index.ts` (plugin registration and integration orchestration)
- `src/client/backendClient.ts` (backend client)
- `src/engine/assemble.ts` (assembly-side integration path)
- `src/commands/cragExplainMemory.ts` (explain-memory command surface)

## Testing

Install:
```bash
npm ci
```

Run core regression walls:
```bash
npm run test:assemble
npm run test:registration
npm test
```

Live acceptance harnesses:
```bash
npm run test:live-acceptance -- <run_id>
npm run test:live-acceptance:closure -- <run_id>
```

## Roadmap Status

Current program order:
1. Epic A: live signoff (completed)
2. Epic B: backend context design parity audit (current focus)
3. Epic C: metrics/smoke/regression safety
4. Epic E: first graph layer

This plugin repo should only change for integration-contract needs and verified plugin/runtime behavior.

## Relation to CognitiveRAG Backend

- Plugin repo (`openclaw-cognitiverag-memory`) = OpenClaw integration adapter
- Backend repo (`CognitiveRAG`) = memory/retrieval/context intelligence and canonical truth

If behavior requires intelligence changes, fix backend first and keep the plugin thin.

## Suggested GitHub Topics

`openclaw`, `rag`, `retrieval-augmented-generation`, `plugin`, `typescript`, `integration-testing`, `context-engine`, `cognitiverag`
