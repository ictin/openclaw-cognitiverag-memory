# openclaw-cognitiverag-memory

This adapter makes CognitiveRAG usable in OpenClaw production flows with runtime safety, contract discipline, and live-proof validation.

## What This Adapter Makes Possible

With this plugin, OpenClaw can consume CognitiveRAG capabilities safely in real sessions:
- resilient integration behavior under backend degradation (fail-open where required)
- stable command/route/context-engine integration surfaces
- runtime parity proof that deployed plugin code matches repo code
- repeatable live acceptance and closure reporting

## Why It Exists

Backend intelligence has no user value if runtime integration is brittle. This repository exists to make CognitiveRAG operationally usable from OpenClaw:
- clean OpenClaw-facing contracts
- explicit status and diagnostics surfaces
- deterministic integration behavior under failure paths
- verifiable readiness signals from live validation

## Core Benefits

- safer rollouts for memory/retrieval integration
- lower risk of silent runtime drift
- clearer proof that live behavior matches intended plugin code
- faster diagnosis when integration or gateway paths degrade

## Ownership Boundaries

This repo owns OpenClaw integration:
- plugin/context-engine wiring
- OpenClaw-facing command/route/service/hook surfaces
- integration-side runtime safety behavior
- live acceptance harness and closure reporting

This repo does **not** own backend intelligence:
- memory policy
- retrieval ranking logic
- contradiction/compatibility intelligence
- discovery intelligence
- graph intelligence

Those belong to `CognitiveRAG`.

## Runtime Safety And Validation

Key proof and validation surfaces:
- `scripts/run_live_agent_acceptance.mjs`
- `scripts/run_live_agent_acceptance_closure.mjs`
- `scripts/score_live_agent_acceptance.mjs`
- `scripts/apply_openclaw_runtime_patch.mjs`
- `scripts/verify_openclaw_runtime_patch.mjs`

These flows verify runtime parity, integration behavior, and closure artifact integrity.

## Install / Run / Test

```bash
npm ci
npm run test:assemble
npm run test:registration
npm test
npm run test:live-acceptance -- <run_id>
npm run test:live-acceptance:closure -- <run_id>
```

## Current Status In The Wider Project

- Epic A integration signoff is complete.
- Epic B (current) is backend design/code parity.
- Epic C is next.
- Graph work is later.

Backend remains the intelligence layer; this repo remains the integration layer.
