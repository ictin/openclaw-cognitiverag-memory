# OpenClaw Runtime Deterministic Short-Circuit Patch

This repository includes a reproducible integration patch for the installed OpenClaw runtime file:

- Target file: `/home/ictin_claw/.npm-global/lib/node_modules/openclaw/dist/pi-embedded-CbCYZxIb.js`
- Purpose: honor deterministic context-engine outputs for `memory_summary` and `corpus_overview` intents on the final emission path.

## Files

- `runtime-shortcircuit-intent-bridge.patch`: unified diff of the runtime change.
- `runtime-shortcircuit-intent-bridge.hashes.txt`: recorded pre/post/runtime patch hashes from forensic capture.
- `../../scripts/apply_openclaw_runtime_patch.mjs`: deterministic local apply script.
- `../../scripts/verify_openclaw_runtime_patch.mjs`: runtime patch verification script.

Forensic runtime snapshots (`.before`/`.after`) are stored in the timestamped `forensics/` bundle, not committed into git.

## Apply

```bash
node scripts/apply_openclaw_runtime_patch.mjs
```

Optional override:

```bash
OPENCLAW_RUNTIME_FILE=/path/to/pi-embedded-CbCYZxIb.js node scripts/apply_openclaw_runtime_patch.mjs
```

## Verify

```bash
node scripts/verify_openclaw_runtime_patch.mjs
```

The verify script fails non-zero if the required deterministic short-circuit runtime hooks are missing.
