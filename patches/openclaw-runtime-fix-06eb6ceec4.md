# OpenClaw runtime fix artifact

- Source repo URL: https://github.com/openclaw/openclaw.git
- Source commit before patch: d3731be2f04810537463989618b748bb4349567e
- Local patch commit hash: 06eb6ceec4
- Target source file: src/agents/subagent-control.ts
- Reason: guard missing sessionEntry before token-usage formatting to prevent a runtime crash in the subagent list/status path.
