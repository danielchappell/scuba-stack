# Runbook

## Daily Use

1. Install the target you use:
   - `bash install.sh claude`
   - `bash install.sh codex`
2. Restart the target runtime so guidance, skills, agents, and hooks are reloaded.
3. Start a lead session:
   - Claude: ask it to act as Scuba Stack's chief of staff.
   - Codex Desktop: type `/prompts:scuba` once in the new thread.
4. For larger work, let the lead run manager mode, keep `.scuba/roadmap.md` current, and dispatch workers according to the target's subagent semantics.

## Target Notes

Claude remains the most complete target. It installs the verified `scuba-guard.sh` `PreToolUse` adapter and wires it into `~/.claude/settings.json` when `jq` is available.

Codex renders guidance, skills, custom agents, a `/prompts:scuba` session initializer, and a Codex-native hook adapter. After install, the hook is wired into `~/.codex/hooks.json` but remains pending trust until the user reviews/trusts it with `/hooks`. Treat it as operational only after trust and a live smoke.

Codex subagent concurrency is capped by Codex settings. Use `agents.max_threads` to raise the number of open agent threads, keep `agents.max_depth` at `1` unless recursive delegation is deliberately needed, and set `agents.job_max_runtime_seconds` when CSV-style subagent jobs need longer runtimes. Close completed agents after their output is captured; completed open agents still count against the cap.

## Verification

Run these after source, target, or installer changes:

```bash
node scripts/test.mjs
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
bash hooks/test-scuba-guard.sh
bash hooks/test-codex-scuba-guard.sh
```

Check rendered output shape:

- Claude agents are Markdown files with concrete `tools:` and `model: opus`.
- Codex agents are TOML files with `name`, `description`, `developer_instructions`, `model`, and `model_reasoning_effort`.
- Codex prompt `scuba.md` is installed under `~/.codex/prompts/` and does not require arguments.
- Codex root guidance is inlined into a managed block in `~/.codex/AGENTS.md`; `@file` references are not treated as startup imports.
- Codex rendered hooks include `scuba-guard.sh`; installed enforcement is pending `/hooks` trust until live-smoked.

## Hook Verification

For Claude:

- `bash hooks/test-scuba-guard.sh` verifies the adapter logic outside the runtime.
- A live smoke test after restart must confirm a user-scope hook fires on worker/subagent tool calls.

For Codex:

- `bash hooks/test-codex-scuba-guard.sh` verifies the adapter logic outside the runtime.
- After `bash install.sh codex`, restart Codex and run `/hooks`; review and trust the Scuba hook entry.
- Live-smoke a blocked draft PR or primary-tree write before claiming enforcement is operational.

## Recovery

Scuba state lives in `.scuba/`, not transcripts. On resume or after compaction:

1. Read `.scuba/roadmap.md`.
2. Verify branch/worktree/PR state from git and files.
3. Re-dispatch any dead worker from its `status.md`; do not rely on transcript history.
