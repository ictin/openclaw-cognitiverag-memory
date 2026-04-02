# Template: Backend Audit Story

## Scope
- Epic/Story:
- In scope:
- Out of scope:

## Plan Grounding
- Read canonical docs from primary path first.
- State fallback usage explicitly if needed.

## Ownership Guardrails
- Backend owns intelligence.
- Plugin untouched unless explicit minimal compatibility need.

## Execution Steps
1. Reproduce/audit current behavior.
2. Identify exact code paths and gaps.
3. Add smallest safe fixes (if needed).
4. Add/update audit tests.
5. Run testing ladder.

## Testing Ladder
- Targeted backend tests:
- Affected subsystem tests:
- Broader suite (if required):
- Runtime canary only if user-visible behavior changed:

## Required Report Sections
- Branch used
- Files changed
- Reference plan check
- Pre-step analysis
- Audit findings by area
- Tests/commands/results
- Safety verdict
- GitHub evidence
- Final verdict + smallest blocker
