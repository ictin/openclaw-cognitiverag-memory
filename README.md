# OpenClaw CognitiveRAG Memory Adapter

Standalone OpenClaw adapter/plugin for CognitiveRAG integration.

## Current status

- Epic A: done (live signoff closed in prior runtime package).
- Epic B: backend parity evidence indicates B3/B4 closure; authority board reconciliation tracked in `docs/project_truth_status.md`.
- Epic C: in progress; plugin C4 smoke/CI/report workflow hardening is now present.
- Epic D: anti-drift governance pack is now repo-native under `docs/governance/`.
- Graph work: not started in this repo.

## Standard validation order

1. `npm run test:assemble`
2. `npm run test:registration`
3. `npm test`
4. `node scripts/run_plugin_ci_smoke.mjs --output ci_artifacts/plugin_ci_smoke_summary.json`
5. `node scripts/run_epic_c4_validation_bundle.mjs --output-dir forensics/<stamp>/c4_validation`

For live runtime closure flow and reports, use `docs/live_acceptance_battery.md`.

## Governance and anti-drift

- Constitution: `docs/governance/implementation_constitution.md`
- Closure checklist: `docs/governance/closure_checklist.md`
- Prompt templates: `docs/governance/templates/`
- Preflight check: `node scripts/governance_preflight.mjs`
