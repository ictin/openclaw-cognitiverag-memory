# Template: Audit/Reconciliation Story

## Scope
- Artifact/source of truth to reconcile:
- Repos in scope:
- Out of scope:

## Reconciliation Rules
- Prove from artifacts, code, tests, and git history.
- Do not trust prior summaries without proof.
- Label stale docs/status surfaces explicitly.

## Execution Steps
1. Capture baseline branch/HEAD/status for each repo in scope.
2. Locate authoritative artifact(s) and latest competing claims.
3. Compare code/test/git evidence against authority/status docs.
4. Classify truth mismatch (stale docs vs stale claims vs missing proof).
5. Apply minimal status/doc corrections only where needed.
6. Re-validate and report exact updated truth.

## Required Report Sections
- Reference plan check
- Baseline proof
- Evidence matrix
- Reconciliation decision
- Minimal files changed
- Validation results
- Merge/push evidence
- Next bounded step
