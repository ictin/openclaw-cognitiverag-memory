# Template: Plugin/Runtime Integration Story

## Scope
- Epic/Story:
- Runtime surfaces affected:
- Out of scope:

## Plan Grounding
- Read canonical docs from primary path first.

## Ownership Guardrails
- Backend owns intelligence.
- Plugin is adapter/reporting/integration layer only.

## Runtime Truth Requirements
- Prove loaded plugin path.
- Prove runtime plugin root.
- Capture repo SHA.
- Capture runtime SHA or code-match proof.

## Execution Steps
1. Reproduce live mismatch.
2. Identify actual runtime handler path.
3. Apply minimal integration fix.
4. Rebuild/reload/sync if needed.
5. Re-run live checks.

## Testing Ladder
- Targeted plugin tests:
- Affected plugin tests:
- Plugin wall:
- Live runtime validation:

## Required Report Sections
- Branch used
- Files changed
- Reference plan check
- Runtime path analysis
- Fix status
- Tests/commands/results
- Runtime proof fields/artifacts
- Safety verdict
- GitHub evidence
- Final verdict + smallest blocker
