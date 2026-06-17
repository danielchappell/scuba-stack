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
- `~/.codex/.scuba-manifest`

Codex hook enforcement is not installed in this cut. The target renders hook policy documentation only, because Codex uses a different hook event contract and needs its own adapter and smoke tests.

## Render Without Installing

```bash
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
```

Use this before changing install behavior or target manifests.

## Safety Rules

- The installer removes only files listed in the previous `.scuba-manifest` for that target.
- The target root guidance file is never overwritten wholesale. Claude appends an import line; Codex maintains a marked Scuba block because Codex does not auto-inline `@file` imports at startup.
- Back up an existing root guidance file before changing it, but do not create new backups when the rendered content is unchanged.
- Settings/config merges must be surgical and temp-then-`mv`.
- Target-specific compatibility branches belong in the installer or target adapter, not in core skills.
