# Runbook

## Daily Use

1. Install the target you use:
   - `bash install.sh claude`
   - `bash install.sh codex`
2. Restart the target runtime so guidance, skills, agents, and hooks are reloaded.
3. Start a lead session and ask it to act as Scuba Stack's chief of staff.
4. For larger work, let the lead run manager mode, keep `.scuba/roadmap.md` current, and dispatch workers according to the target's subagent semantics.

## Target Notes

Claude remains the most complete target. It installs the verified `scuba-guard.sh` `PreToolUse` adapter and wires it into `~/.claude/settings.json` when `jq` is available.

Codex renders guidance, skills, and custom agents. Codex hook enforcement is policy-only until a target adapter is implemented and tested.

## Verification

Run these after source, target, or installer changes:

```bash
node scripts/test.mjs
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
bash hooks/test-scuba-guard.sh
```

Check rendered output shape:

- Claude agents are Markdown files with concrete `tools:` and `model: opus`.
- Codex agents are TOML files with `name`, `description`, `developer_instructions`, `model`, and `model_reasoning_effort`.
- Codex root guidance is inlined into a managed block in `~/.codex/AGENTS.md`; `@file` references are not treated as startup imports.
- Codex rendered hooks include policy documentation but no installed enforcement adapter.

## Hook Verification

For Claude:

- `bash hooks/test-scuba-guard.sh` verifies the adapter logic outside the runtime.
- A live smoke test after restart must confirm a user-scope hook fires on worker/subagent tool calls.

For Codex:

- Do not install enforcement until an adapter has standalone fixtures and a live smoke test for the Codex hook contract.

## Recovery

Scuba state lives in `.scuba/`, not transcripts. On resume or after compaction:

1. Read `.scuba/roadmap.md`.
2. Verify branch/worktree/PR state from git and files.
3. Re-dispatch any dead worker from its `status.md`; do not rely on transcript history.
