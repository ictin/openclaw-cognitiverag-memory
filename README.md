# openclaw-cognitiverag-memory

OpenClaw integration layer for the CognitiveRAG backend.

## What This Repo Is

`openclaw-cognitiverag-memory` is the plugin-side adapter that connects OpenClaw runtime surfaces to CognitiveRAG backend APIs.

It is intentionally thin and integration-focused.

## Why It Exists

OpenClaw needs a stable integration boundary to use CognitiveRAG capabilities (assembly, recall/explain surfaces, health/status reporting) without moving backend intelligence into plugin code.

This repository provides that boundary and verifies it with contract/regression/live-validation harnesses.

## What It Owns

This repo owns OpenClaw-facing integration behavior, including:
- context-engine wiring and registration surfaces
- command/route/service integration exposed to OpenClaw
- safe integration behavior (including fail-open/fail-closed handling where policy requires it)
- runtime-path verification and patch utilities
- smoke/live acceptance harness orchestration and reporting

## What It Does Not Own

This repo does **not** own backend intelligence. It does not define or own:
- memory policy or long-term memory taxonomy
- retrieval lane ranking logic
- contradiction/compatibility intelligence
- discovery reasoning policy
- graph intelligence/modeling

Those responsibilities remain in the `CognitiveRAG` backend repository.

## Architecture And Boundaries

Flow:
1. OpenClaw invokes plugin surfaces.
2. Plugin normalizes/validates integration request shape.
3. Plugin calls CognitiveRAG backend contracts.
4. Plugin returns policy-compliant, source-truthful responses to OpenClaw.

Key files:
- `index.ts` (plugin entrypoint and OpenClaw registration)
- `src/client/backendClient.ts` (backend integration client)
- `src/engine/assemble.ts` (assemble integration path)
- `src/commands/cragExplainMemory.ts` (explain-memory command path)

## Live Validation And Acceptance

This repository includes live acceptance runners and closure reporting:
- `scripts/run_live_agent_acceptance.mjs`
- `scripts/run_live_agent_acceptance_closure.mjs`
- `scripts/score_live_agent_acceptance.mjs`

The acceptance path is used to validate:
- runtime path parity (`runtimeCodeMatchesRepo` style proof)
- command/route integration behavior
- source-class/truthfulness output constraints
- grouped closure status and artifact emission

## Install / Run / Test

Install:
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

## What Is Working Today

- OpenClaw plugin integration and backend contract routing are in place.
- Regression test walls for assemble/registration/live-reporting are in place.
- Runtime patch apply/verify scripts are in place.
- Epic A live-signoff closure work is completed at plugin integration level.

## Current Project Status

Current program order:
1. Epic A completed
2. Epic B (current): backend context-design parity check and closure of partial areas
3. Epic C: metrics/smoke/regression safety hardening
4. Graph layer work later (not current phase)

## Relation To CognitiveRAG Backend

- `openclaw-cognitiverag-memory` = OpenClaw integration adapter
- `CognitiveRAG` = backend intelligence and canonical retrieval/memory/context logic

If a behavior requires changing intelligence policy, the fix belongs in the backend, not this plugin.

## Roadmap Status

This plugin should evolve only where integration contracts, runtime proof, or OpenClaw-facing stability require it.
