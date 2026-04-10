# openclaw-cognitiverag-memory

Production integration adapter that lets OpenClaw use CognitiveRAG safely in real sessions.

## What This Adapter Makes Possible

With this plugin, an OpenClaw agent can use CognitiveRAG without sacrificing runtime safety:
- fail-open integration behavior when backend paths degrade
- stable OpenClaw-facing command/route/context-engine wiring
- runtime parity proof (`repo code == loaded runtime code`)
- repeatable live acceptance runs and closure artifacts
- clear source-truthfulness integration contracts

This repository turns backend intelligence into a reliable OpenClaw runtime surface.

## Why The Plugin Exists

CognitiveRAG backend capabilities are only useful if OpenClaw can consume them safely and consistently. This plugin exists to provide that boundary layer:
- strict integration contracts
- operational diagnostics and status visibility
- regression and live validation harnesses
- controlled rollout behavior under real runtime conditions

## What It Owns

This repo owns OpenClaw integration concerns:
- context-engine and plugin wiring
- OpenClaw-facing commands/routes/services/hooks
- integration-side fail-open/fail-closed behavior required by policy
- runtime patch/verification utilities
- smoke, acceptance, and closure orchestration for integration validation

## What It Does Not Own

This repo does **not** own backend intelligence. It does not define:
- memory intelligence and memory policy
- retrieval ranking strategy
- contradiction/compatibility intelligence
- discovery reasoning policy
- graph intelligence

Those responsibilities belong to the `CognitiveRAG` backend repository.

## Architecture And Boundaries

Flow:
1. OpenClaw invokes plugin surfaces.
2. Plugin validates/normalizes integration input.
3. Plugin calls CognitiveRAG backend contracts.
4. Plugin returns policy-compliant, source-truthful output to OpenClaw.

Key integration files:
- `index.ts`
- `src/client/backendClient.ts`
- `src/engine/assemble.ts`
- `src/commands/cragExplainMemory.ts`

## Runtime Safety And Live Validation

This repo includes runtime and live-proof tooling:
- `scripts/run_live_agent_acceptance.mjs`
- `scripts/run_live_agent_acceptance_closure.mjs`
- `scripts/score_live_agent_acceptance.mjs`
- `scripts/apply_openclaw_runtime_patch.mjs`
- `scripts/verify_openclaw_runtime_patch.mjs`

These flows validate:
- runtime path parity
- command and route integration correctness
- source-class/truthfulness integration behavior
- grouped closure artifact emission

## Install / Run / Test

Install dependencies:
```bash
npm ci
```

Core regression walls:
```bash
npm run test:assemble
npm run test:registration
npm test
```

Live acceptance entrypoints:
```bash
npm run test:live-acceptance -- <run_id>
npm run test:live-acceptance:closure -- <run_id>
```

## Current Status In The Broader Project

- Epic A (live signoff) is complete at integration level.
- Current global phase is Epic B (backend context-design parity).
- Epic C follows.
- Graph phase is later and is not current plugin scope.

## Relation To The CognitiveRAG Backend

- `openclaw-cognitiverag-memory`: OpenClaw integration layer
- `CognitiveRAG`: backend intelligence and canonical memory/retrieval/context logic

If a change requires intelligence policy updates, it should be implemented in `CognitiveRAG`, not here.
