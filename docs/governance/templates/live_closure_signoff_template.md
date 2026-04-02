# Template: Live Closure / Signoff Story

## Scope
- Closure target:
- Critical tests:
- Allowed fallback mode (if any):

## Plan Grounding
- Read canonical docs from primary path first.

## Ownership Guardrails
- Backend owns intelligence.
- Plugin owns OpenClaw integration and validation/reporting glue.
- Do not move intelligence into plugin during closure work.

## Signoff Rules
- No critical hard fails.
- Full closure artifact required.
- Runtime proof fields required in final artifact.

## Execution Steps
1. Attempt monolithic closure run.
2. If churn blocks completion, run grouped resumable closure.
3. Aggregate into final closure artifact.
4. Fix real failures and rerun impacted groups.

## Testing Ladder
- Targeted reruns for failing tests/groups
- Critical-group reruns after fixes
- Full closure rerun
- Runtime proof field verification in final artifact

## Required Artifacts
- Final JSON closure artifact
- Final markdown closure report
- Explicit critical failure list
- READY/NOT READY signoff

## Required Report Sections
- Branch used
- Files changed
- Reference plan check
- Closure analysis
- Final acceptance results
- Tests/commands/results
- Safety verdict
- GitHub evidence
- Final verdict + smallest blocker
