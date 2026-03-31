# Live OpenClaw Agent Acceptance Battery

This battery runs the real OpenClaw gateway/agent path and scores live behavior for:

- status/explain truthfulness
- session recall/provenance
- memory-intent routing (`remember` vs `know`)
- corpus/web evidence behavior
- bounded discovery behavior
- skill-memory generation/explain flows
- execution/evaluation memory write/read checks
- restart persistence
- optional direct backend persistence checks

## Commands

```bash
npm run test:live-acceptance
npm run test:live-acceptance:closure
npm run test:live-acceptance:report
```

`test:live-acceptance:closure` performs:
- one monolithic full-battery attempt
- automatic fallback to grouped resumable closure batches when gateway churn blocks monolithic completion
- final aggregated closure artifacts:
  - `final_live_acceptance_results.json`
  - `final_live_acceptance_report.md`

## Artifacts

Each run writes to:

- `forensics/live_acceptance_reports/<stamp>/live_acceptance_results.json`
- `forensics/live_acceptance_reports/<stamp>/live_acceptance_report.md`

Latest pointer:

- `forensics/.latest_live_acceptance_report`

## Scoring

- Per test: `0` fail, `1` partial, `2` pass.
- Critical no-hard-fail tests are enforced and surfaced in `criticalFailures`.

The runner exits non-zero when any critical test scores `0`.
