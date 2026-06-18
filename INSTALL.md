# Install

Scuba Stack installs a rendered target projection from the neutral source bundle.

## Commands

```bash
bash install.sh          # Claude, backward-compatible default
bash install.sh claude
bash install.sh codex
```

The installer is idempotent and manifest-driven. Re-run it anytime after changing `core/`, `skills/`, `agents/`, `targets/`, or `project-template/`.

## Claude Target

Installs to:

- `~/.claude/scuba.md`
- `~/.claude/CLAUDE.md` import line: `@~/.claude/scuba.md`
- `~/.claude/skills/`
- `~/.claude/agents/`
- `~/.claude/hooks/`
- `~/.claude/settings.json` hook entry, when `jq` is available
- `~/.claude/.scuba-manifest`

First-time Claude setup still requires enabling Agent Teams in `~/.claude/settings.json` and restarting the terminal:

```json
{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}
```

## Codex Target

Installs to:

- `~/.codex/scuba.md`
- `~/.codex/AGENTS.md` managed Scuba block
- `~/.agents/skills/`
- `~/.codex/agents/`
- `~/.codex/prompts/scuba.md`
- `~/.codex/hooks/`
- `~/.codex/hooks.json` hook entry, when `jq` is available
- `~/.codex/.scuba-manifest`

Codex hook enforcement installs as **installed, pending trust**. After installing, restart Codex and use `/hooks` to review and trust the Scuba command hook. Treat enforcement as operational only after the hook is trusted and a live smoke confirms it fires in the current Codex environment.

Scuba writes Codex hook configuration only to `~/.codex/hooks.json`, not `~/.codex/config.toml`.

Start a Codex Desktop Scuba session by typing `/prompts:scuba` once in a new thread. That initializer loads the installed `chief-of-staff` skill, authorizes Scuba-required Codex delegation for the active session, and tells the lead to stop and report if Codex refuses required delegation. It does not bypass Codex sandbox, security, hook trust, or permission prompts.

Codex does not currently expose an installer-level way to make every generic New Thread fully Scuba-active. The prompt initializer is the supported Desktop entrypoint.

Codex subagent concurrency is controlled by Codex settings, not by Scuba role files. The supported knobs are `agents.max_threads`, `agents.max_depth`, and `agents.job_max_runtime_seconds` in Codex config. Completed agents must be closed after their output is captured so they stop counting against the open-thread cap.

## Render Without Installing

```bash
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
```

Use this before changing install behavior or target manifests.

Also run the hook fixtures after hook changes:

```bash
bash hooks/test-scuba-guard.sh
bash hooks/test-codex-scuba-guard.sh
```

## Safety Rules

- The installer removes only files listed in the previous `.scuba-manifest` for that target.
- The target root guidance file is never overwritten wholesale. Claude appends an import line; Codex maintains a marked Scuba block because Codex does not auto-inline `@file` imports at startup.
- Back up an existing root guidance file before changing it, but do not create new backups when the rendered content is unchanged.
- Settings/config merges must be surgical and temp-then-`mv`.
- Target-specific compatibility branches belong in the installer or target adapter, not in core skills.
