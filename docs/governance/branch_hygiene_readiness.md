# Branch Hygiene and Readiness Discipline

## 1) Branch Hygiene

- Verify active branch before editing.
- Do not commit unrelated changes, caches, or forensics noise.
- Stage by explicit file paths when worktree is dirty.
- Push branch and report exact SHA.

## 2) Readiness Rules

- Do not mark READY from targeted reruns alone if broader/closure validation is required.
- Do not treat repo-only success as runtime success.
- Require closure artifacts when the story requires closure/signoff.

## 3) When Runtime Validation Is Required

Runtime validation is required when changes affect:
- slash command outputs
- live routing/intent behavior
- runtime-loaded plugin/report paths
- smoke/acceptance report semantics

## 4) When Runtime Validation Is Not Required

Runtime validation is usually not required for:
- doc-only changes
- internal test-only backend audits with no user-visible behavior change

## 5) Failure Discipline

- If required proofs are missing, report NOT READY.
- Keep one smallest blocker in final report when not ready.
