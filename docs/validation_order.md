# Standard Validation Order

This order is the default for plugin-side runtime integration work.

## 1) Repo tests first

1. `npm run test:assemble`
2. `npm run test:registration`
3. `npm test`

## 2) Plugin smoke wrapper

Run CI-safe smoke with machine-readable runtime/path proof:

```bash
node scripts/run_plugin_ci_smoke.mjs --output ci_artifacts/plugin_ci_smoke_summary.json
```

When real runtime is required on a local operator machine, require runtime proof:

```bash
node scripts/run_plugin_ci_smoke.mjs --require-runtime
```

## 3) Acceptance/report workflow

For runtime-facing signoff:

```bash
npm run smoke:live-memory
npm run test:live-acceptance
npm run test:live-acceptance:closure
npm run test:live-acceptance:report
```

Required closure artifacts:

- `final_live_acceptance_results.json`
- `final_live_acceptance_report.md`

Required runtime truth fields:

- runtime entry path
- runtime plugin root
- runtime/repo match or commit SHA proof
