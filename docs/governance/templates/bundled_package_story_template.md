# Template: Bundled Package Story

## Scope
- Package stories included:
- Package-level success conditions:
- Out of scope:

## Plan Grounding
- Read canonical docs from primary path first.
- List anti-drift points checked.

## Ownership Guardrails
- Backend owns intelligence.
- Plugin owns integration/runtime/reporting glue.
- Keep mirrors as support/export/debug surfaces.

## Execution Plan
1. Audit current baseline per sub-story.
2. Implement minimal coherent changes.
3. Add tests/proofs per sub-story.
4. Run testing ladder in order.
5. Generate package-level summary artifacts.

## Testing Ladder
- Targeted tests by sub-story:
- Affected subsystem tests:
- Broader suite if required:
- Runtime validation only if user-visible behavior changed:

## Truthfulness Requirements
- Mark each sub-story READY/NOT READY independently.
- Mark package READY only when all required sub-stories are READY.
- Call out heuristic/provisional pieces explicitly.

## Required Report Sections
- Branch used
- Files changed
- Reference plan check
- Pre-step analysis
- Package audit by sub-story
- Tests/commands/results
- Safety verdict
- GitHub evidence
- Final verdict + smallest blocker
