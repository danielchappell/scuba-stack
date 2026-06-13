# Install — Scuba Stack

The system installs once at the **user scope** (`~/.claude`) and works in every project. Each project keeps only its own specifics.

## Fastest path
From this folder:

    bash install.sh

It's idempotent: **re-run it anytime to update to the latest** — it cleanly replaces only the org's files and never touches your other skills, agents, or personal `CLAUDE.md` content. Then do the one-time manual step it prints (enable Agent Teams).

## What goes where
- `~/.claude/skills/` <- the skill folders in `skills/` (the system; loads on demand)
- `~/.claude/agents/` <- the files in `agents/`
- `~/.claude/scuba.md` <- `global-CLAUDE.md` (the tiny always-on pointer)
- `~/.claude/CLAUDE.md` <- gets one import line, `@~/.claude/scuba.md`, **appended once** if it isn't already there. Your own content is **never overwritten**; the file is backed up to `~/.claude/CLAUDE.md.scuba-bak.<timestamp>` before that one edit, and re-runs are no-ops once the line is present.
- `~/.claude/.scuba-manifest` <- internal list of the org's files, so reinstall can clean surgically.
- per repo: nothing required. The chief of staff creates the `.scuba/` board itself on first use. Optionally add project specifics (stack, paths, commands) to that repo's own `CLAUDE.md`.

## Updating
Re-run `bash install.sh` from the latest bundle. Renamed or removed skills from a previous version are cleaned up automatically; your non-org files are left alone. No uninstall needed first.

## Upgrading from a pre-release (orchestration-named) build
Very early builds used different file names — pointer `~/.claude/orchestration.md`, manifest `~/.claude/.orchestration-manifest`, board `.orchestration/` — now `scuba.md`, `.scuba-manifest`, and `.scuba/`. Because the installer is append-only and reads only the new manifest, upgrading from such a build needs a one-time manual cleanup:
1. Delete the files the old installer left (`~/.claude/.orchestration-manifest`, the skill/agent files it had installed, and `~/.claude/orchestration.md`), then re-run `bash install.sh`.
2. In `~/.claude/CLAUDE.md`, replace the line `@~/.claude/orchestration.md` with `@~/.claude/scuba.md`.
3. Per project: rename any existing `.orchestration/` board directory to `.scuba/`, or let the chief of staff create a fresh one.

## Enable Agent Teams (manual)
Add the flag to the `env` block of `~/.claude/settings.json`, then restart your terminal. If the file already has an `env` block, just add the line inside it; if the file is new, this whole object is fine:

    { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }

Requires Claude Code v2.1.32 or later (`claude --version`). Verify after restart with `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (should print `1`).

## Verify
Open Claude Code in a repo and run `/memory`. You should see `~/.claude/CLAUDE.md` loaded. The skills load their one-line descriptions automatically; their bodies load only when triggered.

## Daily use
See `RUNBOOK.md`.
