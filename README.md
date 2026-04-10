# OpenClaw CognitiveRAG Memory Adapter

**This repo makes CognitiveRAG usable inside the real OpenClaw runtime.**
It is the production integration layer that connects OpenClaw sessions, commands, and context-engine hooks to the CognitiveRAG backend while preserving fail-open safety, live validation, and runtime proof.

## What this adapter makes possible

This adapter exists so OpenClaw can use CognitiveRAG safely and verifiably in real runtime behavior.

It provides:
- **Runtime-safe integration** between OpenClaw and the CognitiveRAG backend.
- **Fail-open runtime behavior** so backend degradation does not silently corrupt agent behavior.
- **Live acceptance validation** so claims are tested in real OpenClaw execution paths.
- **Runtime proof** so artifacts show which code path and commit were actually loaded.
- **Clear responsibility boundaries** so backend intelligence stays in the backend.

## Why it exists

CognitiveRAG is the intelligence layer.
This repo is the integration layer.

Without this adapter, strong backend intelligence can still fail in production due to wiring, command routing, runtime drift, or lifecycle mismatch.

## Core benefits

- safer production rollout of memory/retrieval integration
- lower risk of hidden runtime drift
- stronger confidence from live closure artifacts
- faster diagnosis when runtime integration degrades

## What it owns

- OpenClaw plugin/context-engine wiring
- OpenClaw-facing command/route/service/hook registration
- integration-side fail-open/fail-closed behavior required by policy
- runtime patch/apply/verify surfaces
- smoke/live acceptance harnesses and closure reporting

## What it does not own

This repository does **not** own:
- retrieval intelligence
- ranking policy
- promoted-memory intelligence
- reasoning intelligence
- graph intelligence
- discovery intelligence

Those belong to `CognitiveRAG`.

## Runtime safety and validation

Key proof and validation surfaces:
- `scripts/run_live_agent_acceptance.mjs`
- `scripts/run_live_agent_acceptance_closure.mjs`
- `scripts/score_live_agent_acceptance.mjs`
- `scripts/apply_openclaw_runtime_patch.mjs`
- `scripts/verify_openclaw_runtime_patch.mjs`

These flows verify runtime parity, integration behavior, and closure artifact integrity.

## Install / run / test

```bash
npm ci
npm run test:assemble
npm run test:registration
npm test
npm run test:live-acceptance -- <run_id>
npm run test:live-acceptance:closure -- <run_id>
```

## Current status in the wider project

- Epic A integration signoff is done.
- Epic B is current.
- Epic C is next.
- Graph work is later.

Backend remains the intelligence layer; this repository remains the OpenClaw integration layer.
