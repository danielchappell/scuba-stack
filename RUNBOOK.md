# Runbook

## Daily Use

1. Install the target you use:
   - `bash install.sh claude`
   - `bash install.sh codex`
2. Restart the target runtime so guidance, skills, agents, tools, and hooks are reloaded.
3. Start a lead session:
   - Claude: ask it to act as Scuba Stack's chief of staff.
   - Codex Desktop: invoke the `$scuba` skill in the thread that should use Scuba.
4. For larger work, let the lead run manager mode, keep `.scuba/roadmap.md` current, and dispatch workers according to the target's subagent semantics.

## Target Notes

Claude remains the most complete target. It installs shared tools under `~/.claude/tools`, installs the verified `scuba-guard.sh` `PreToolUse` adapter, and wires the hook into `~/.claude/settings.json` when `jq` is available.

Codex installs skills, custom agents, shared tools under `~/.codex/tools`, the manual `$scuba` entrypoint skill, and a Codex-native hook adapter. It does not write Scuba into `~/.codex/AGENTS.md`, so ordinary new threads remain non-Scuba by default. After install, the hook is wired into `~/.codex/hooks.json`; that is only installed configuration. It remains pending trust until the user reviews/trusts it with `/hooks`, and it is operational only after trust plus a live denied tool call proves enforcement in the current Codex runtime.

Codex subagent concurrency is capped by Codex settings. Use `agents.max_threads` to raise the number of open agent threads, keep `agents.max_depth` at `1` unless recursive delegation is deliberately needed, and set `agents.job_max_runtime_seconds` when CSV-style subagent jobs need longer runtimes. Close completed agents after their output is captured; completed open agents still count against the cap.

## Verification

Run these after source, target, or installer changes:

```bash
node scripts/test.mjs
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
node scripts/audit-codex-jsonl.mjs --list-recent
bash hooks/test-scuba-guard.sh
bash hooks/test-codex-scuba-guard.sh
```

Check rendered output shape:

- Claude agents are Markdown files with concrete `tools:` and `model: opus`.
- Codex agents are TOML files with `name`, `description`, `developer_instructions`, `model`, and `model_reasoning_effort`.
- Both targets render `tools/pr-feedback-watch.mjs`; install places it under `~/.claude/tools` or `~/.codex/tools`.
- Codex installs the manual `scuba` skill under `~/.agents/skills/scuba/`; invoke it with `$scuba` only in threads that should use Scuba.
- Codex root guidance is not modified for Scuba; the installer removes any stale Scuba managed block or legacy `@~/.codex/scuba.md` import from `~/.codex/AGENTS.md`.
- Codex rendered hooks include `scuba-guard.sh`; installed enforcement is pending `/hooks` trust until live-smoked.

## Codex JSONL Audit

Codex writes session JSONL under `~/.codex/sessions` and archived session JSONL under `~/.codex/archived_sessions`. To inspect whether a Scuba session actually spawned the expected subagents, first find the root thread id:

```bash
node scripts/audit-codex-jsonl.mjs --list-recent
```

Then render the parent/subagent audit tree:

```bash
node scripts/audit-codex-jsonl.mjs <root-thread-id> --out /tmp/scuba-codex-audit.md
```

For acceptance gates, make the audit fail closed:

```bash
node scripts/audit-codex-jsonl.mjs <root-thread-id> --acceptance --out /tmp/scuba-codex-audit.md
```

Add `--require-subagents --require-subagent-metadata` only when the proof claim depends on worker/subagent metadata. In acceptance mode, missing root JSONL, JSON parse errors, and task starts without a matching complete or abort exit nonzero after the report is written when possible.

The report uses operational metadata by default: parent/child thread ids, subagent nickname/role, task starts/completions, tool-call names, `.scuba` path evidence, worktree path evidence, and raw JSONL file paths for deeper inspection. It intentionally does not print raw transcript or reasoning text.

## Hook Verification

For Claude:

- `bash hooks/test-scuba-guard.sh` verifies the adapter logic outside the runtime.
- A live smoke test after restart must confirm a user-scope hook fires on worker/subagent tool calls.

For Codex:

- `bash hooks/test-codex-scuba-guard.sh` verifies the adapter logic outside the runtime.
- After `bash install.sh codex`, restart Codex and run `/hooks`; review and trust the Scuba hook entry.
- Live-smoke a blocked draft PR pattern or primary-tree write before claiming enforcement is operational. Prefer the non-mutating draft probe `gh pr create --draft --help` as a Codex tool call; the hook must deny it before help runs. If the command runs and prints help, record a hook-proof gap.

Hook fixture tests are supplemental. They prove adapter logic for representative JSON input, not live runtime trust.

## Recovery

Scuba state lives in `.scuba/`, not transcripts. On resume or after compaction:

1. Read `.scuba/roadmap.md`.
2. Verify branch/worktree/PR state from git and files.
3. Re-dispatch any dead worker from its `status.md`; do not rely on transcript history.
