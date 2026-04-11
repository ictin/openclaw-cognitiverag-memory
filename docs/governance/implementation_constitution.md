# Implementation Constitution

This constitution is binding for implementation runs in this repo.

## 1) Ownership Split

- Backend owns intelligence.
- Plugin owns OpenClaw integration only.
- Do not move backend intelligence into plugin rendering/routing except minimal integration glue.

## 2) Memory Truth

- Markdown files are mirrors/support/export/debug surfaces.
- Mirrors are not canonical memory.
- User-facing answers must not present mirrors as the whole system.

## 3) Runtime Truth

- Repo diffs are not enough for runtime-facing fixes.
- For runtime-visible changes, prove:
  - actual loaded plugin path
  - runtime plugin root
  - runtime code-match or runtime SHA vs repo SHA
- If repo and runtime disagree, debug runtime load path first.

## 4) Scope Discipline

- Work only the requested story/package scope.
- Do not jump to future epics.
- Do not start graph/federation/trust expansion unless explicitly in scope.

## 5) Testing Ladder

Always validate in this order:
1. targeted tests
2. affected subsystem tests
3. broader suite (if behavior changed materially)
4. live runtime acceptance (if user-visible behavior changed)

## 6) Discovery Rules

- Discovery must stay bounded, explainable, and provenance-backed.
- Do not add plugin-owned discovery intelligence.

## 7) Weak-Model Rule

- For routing-sensitive behavior, test at least one weaker/default model path.
- Do not sign off only from strong-model behavior.

## 8) Truthfulness Rule

- Never mark READY without proof from tests/artifacts.
- If safeguards are heuristic/provisional, state that explicitly.
- Prefer explicit NOT READY over optimistic claims.

## 9) Signoff Integrity Rule

- Do not call signoff from partial reruns alone.
- For grouped/runtime closure stories, require final closure artifacts for closure claims.
