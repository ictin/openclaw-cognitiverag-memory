# Closure Checklist

Use this checklist before final signoff.

## A. Plan + Scope

- [ ] Canonical plan docs were read from primary path.
- [ ] Fallback path used only if primary unavailable.
- [ ] Scope stayed aligned to requested story/package.
- [ ] No unrelated feature or architecture drift was introduced.

## B. Implementation Completeness

- [ ] Required artifacts/modules/files exist.
- [ ] Required behaviors are implemented (not only described).
- [ ] Partial/heuristic parts are explicitly labeled.

## C. Testing Ladder

- [ ] Targeted tests executed and passed.
- [ ] Affected subsystem tests executed and passed.
- [ ] Broader suite executed when material change required.
- [ ] Live runtime validation executed when user-visible behavior changed.

## D. Runtime Proof (when applicable)

- [ ] Runtime entry path identified.
- [ ] Runtime plugin root identified.
- [ ] Repo SHA captured.
- [ ] Runtime SHA/code-match proof captured.
- [ ] Runtime/report artifacts include these fields.

## E. Artifacts + Reporting

- [ ] Required closure/report artifacts exist.
- [ ] Artifacts use stable key names (machine-readable shape).
- [ ] Failures are surfaced explicitly (not silently swallowed).
- [ ] Final report includes exact commands and exact results.

## F. Hygiene + Delivery

- [ ] Active branch verified before editing.
- [ ] Only intended files committed.
- [ ] Branch pushed successfully.
- [ ] Final report includes commit SHA and final verdict (READY/NOT READY).
