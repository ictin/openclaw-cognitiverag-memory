# autoresearch Fit Assessment (M14.5)

Repository assessed: `https://github.com/karpathy/autoresearch`

## Verdict
Suitable as an **outer-loop experiment harness**, not as a runtime dependency.

## Why it fits
- Useful for prompt-policy experimentation over repeated trials.
- Good match for offline tuning loops:
  - skill distillation prompts
  - rubric wording/criterion tuning
  - skill-pack retrieval prompt tuning
  - evaluation prompt tuning
  - craft-book extraction experiments

## Why it should not be runtime-coupled now
- Runtime CRAG/OpenClaw path needs deterministic, bounded, low-latency behavior.
- `autoresearch` is naturally exploratory/iterative and would add runtime complexity.
- Current milestone scope requires integration glue and live validation, not a new runtime planner.

## Recommended role
- Run as offline/outer-loop research workflow.
- Export resulting tuned prompt/config artifacts back into backend/plugin contracts after validation.
- Keep production OpenClaw path independent from `autoresearch` execution.
