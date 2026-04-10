# OpenClaw CognitiveRAG Memory Adapter

**This repo makes CognitiveRAG usable inside the real OpenClaw runtime.**  
It is the production integration layer that connects OpenClaw sessions, commands, and context-engine hooks to the CognitiveRAG backend while preserving fail-open safety, live validation, and runtime proof.

---

## What this adapter makes possible

This adapter exists so OpenClaw can use CognitiveRAG safely and verifiably in real runtime behavior.

It provides:

- **runtime-safe integration** between OpenClaw and the CognitiveRAG backend
- **fail-open behavior** so integration issues do not silently turn into unsafe behavior
- **live acceptance validation** so runtime claims are tested in the real OpenClaw environment
- **runtime proof** so reports show which plugin path and commit were actually loaded
- **clear responsibility boundaries** so backend intelligence stays in the backend

In plain terms: this is the layer that turns CognitiveRAG from “backend code that exists” into “something OpenClaw can actually use in production-like runtime flows.”

---

## Why this exists

CognitiveRAG is the intelligence layer.  
This repository is the integration layer.

That boundary matters.

Without it, intelligence logic leaks into the adapter, runtime bugs become harder to reason about, and it becomes unclear which repository is responsible for what.

This adapter keeps the roles clean:
- the backend decides how memory, retrieval, selection, and explanation work
- the plugin makes that intelligence usable inside OpenClaw safely

---

## Core benefits

### 1. Safe runtime integration
The adapter is responsible for making backend features usable in the live OpenClaw environment without pretending the runtime is the same as a local unit test.

### 2. Fail-open behavior
When integration breaks, the runtime should degrade safely instead of producing confusing or brittle behavior.

### 3. Live validation and acceptance
This repository owns the live-facing validation path that proves the system works where it actually matters: inside OpenClaw.

### 4. Runtime proof
Reports should show what plugin path was loaded, what commit was used, and what runtime behavior was actually tested.

### 5. Clear boundaries
This repo makes the backend/plugin split explicit and enforceable.

---

## What this repo owns

This adapter owns the OpenClaw-facing side of the system:

- plugin registration
- context-engine registration
- OpenClaw session bridging
- command surfaces
- deterministic integration behavior
- fail-open safety in the adapter layer
- smoke checks
- live acceptance harnesses
- runtime-proof/report surfaces
- adapter-level validation behavior

If it is about making CognitiveRAG usable in the real OpenClaw runtime, it probably belongs here.

---

## What this repo does not own

This repository does **not** own the core intelligence.

It does not own:
- retrieval intelligence
- ranking logic
- promoted memory logic
- reasoning reuse logic
- contradiction logic
- graph logic
- discovery intelligence
- core memory architecture

Those belong in the backend repository.

Backend repo:
- `https://github.com/ictin/CognitiveRAG`

---

## Why this is important

A strong backend without a strong runtime adapter is still not enough.

In real use, you need to know:
- which code path OpenClaw actually loaded
- whether the runtime used the expected plugin build
- whether the answer came from the right source class
- whether live behavior matches repo behavior
- whether failures degrade safely instead of turning into silent corruption

That is the problem this repo solves.

---

## Runtime safety and validation

This repo treats runtime proof as a first-class concern.

That includes:
- proving the live plugin path
- proving the commit SHA used in live runs
- running smoke and wall checks
- running grouped live acceptance
- storing closure artifacts
- distinguishing targeted reruns from real signoff runs

This is the difference between:
- “the repo tests passed”
and
- “the actual OpenClaw runtime is green”

---

## Current status

The live signoff path is completed.

The current project focus is now on backend design/code parity and follow-up hardening there, not on pretending the adapter is the intelligence layer.

Graph work has not started in this repo.  
This repo’s job is still to keep the OpenClaw integration safe, truthful, and testable.

---

## High-level architecture

At a high level:

1. OpenClaw invokes the adapter
2. the adapter bridges runtime/session/context-engine surfaces
3. the adapter calls the CognitiveRAG backend contracts
4. the backend assembles intelligence-driven context
5. the adapter returns the OpenClaw-facing result
6. smoke/live acceptance flows prove the runtime path and result quality

This means the adapter is deliberately thin in intelligence terms, but strong in runtime discipline.

---

## Repository layout

Typical important areas include:

- `index.ts` — adapter entry and OpenClaw integration surface
- `scripts/` — smoke, harness, and live acceptance helpers
- `test/` or `tests/` — adapter-facing tests
- runtime/forensics/report outputs — live proof and debugging artifacts where applicable

---

## Install

Clone the repository:

```bash
git clone https://github.com/ictin/openclaw-cognitiverag-memory.git
cd openclaw-cognitiverag-memory
```

Install dependencies:

```bash
npm install
```

Make sure the matching CognitiveRAG backend is available and configured for the environment where the adapter will run.

---

## Run tests

Core adapter checks:

```bash
npm run test:registration
npm run test:assemble
npm test
```

For live validation and signoff work, also run the relevant smoke and acceptance harness flows in the real OpenClaw runtime.

Repo tests alone are not enough when runtime behavior is affected.

---

## Live validation philosophy

This repo assumes:

- no repo-only success for runtime behavior
- no final signoff from partial reruns alone
- no silent mismatch between runtime path and claimed code
- no silent fallback to the wrong source class

When runtime behavior changes, the adapter must help prove what really happened live.

---

## Relationship to the backend repo

This repository works together with:

- `https://github.com/ictin/CognitiveRAG`

That backend owns:
- memory logic
- retrieval
- ranking
- promoted memory
- reasoning reuse
- explanation artifacts
- later graph/trust/discovery extensions

This adapter owns:
- OpenClaw integration
- runtime proof
- live acceptance surfaces
- fail-open adapter behavior

---

## Development principles

This repo follows a few simple rules:

- plugin owns integration, not intelligence
- runtime proof matters
- fail-open behavior matters
- live validation matters
- truthfulness about source class matters
- adapter code should stay as thin as safely possible

---

## Current roadmap direction

Near-term direction for this repo is:
- keep the OpenClaw integration truthful and stable
- keep live validation strong
- support backend parity and follow-up hardening
- avoid drifting into backend intelligence work

Later backend features may grow, but this repo should continue to act as the disciplined runtime bridge.

---

## Why this repo matters

If CognitiveRAG is the part that makes the agent smarter, this adapter is the part that makes that intelligence usable in the real OpenClaw runtime without turning into brittle integration glue.

That is its job, and that is why this repository exists.
