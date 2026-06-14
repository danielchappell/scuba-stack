# Install — Scuba Stack

The system installs once at the **user scope** (`~/.claude`) and works in every project. Each project keeps only its own specifics.

## Prerequisites
- **`jq`** — used only to wire the enforcement hook into `~/.claude/settings.json`. If `jq` is absent the installer still installs everything else and copies the hook script, but it **skips wiring the hook** and prints the exact JSON to paste by hand; install `jq` and re-run to enable enforcement.

## Fastest path
From this folder:

    bash install.sh

It's idempotent: **re-run it anytime to update to the latest** — it cleanly replaces only the org's files and never touches your other skills, agents, or personal `CLAUDE.md` content. Then do the one-time manual step it prints (enable Agent Teams).

## What goes where
- `~/.claude/skills/` <- the skill folders in `skills/` (the system; loads on demand)
- `~/.claude/agents/` <- the files in `agents/`
- `~/.claude/hooks/` <- the enforcement hook (`scuba-guard.sh`), made executable
- `~/.claude/settings.json` <- **one** `PreToolUse` entry merged in (the hook's wiring), via temp-then-`mv`; every other key you have is left untouched and the file is backed up before the first edit (`settings.json.scuba-bak.<timestamp>`)
- `~/.claude/scuba.md` <- `global-CLAUDE.md` (the tiny always-on pointer)
- `~/.claude/CLAUDE.md` <- gets one import line, `@~/.claude/scuba.md`, **appended once** if it isn't already there. Your own content is **never overwritten**; the file is backed up to `~/.claude/CLAUDE.md.scuba-bak.<timestamp>` before that one edit, and re-runs are no-ops once the line is present.
- `~/.claude/.scuba-manifest` <- internal list of the org's files, so reinstall can clean surgically.
- per repo: nothing required. The chief of staff creates the `.scuba/` control plane itself on first use. Optionally add project specifics (stack, paths, commands) to that repo's own `CLAUDE.md`.

## Updating
Re-run `bash install.sh` from the latest bundle. Renamed or removed skills from a previous version are cleaned up automatically; your non-org files are left alone. No uninstall needed first.

## Upgrading from a pre-release (orchestration-named) build
Very early builds used different file names — pointer `~/.claude/orchestration.md`, manifest `~/.claude/.orchestration-manifest`, control plane `.orchestration/` — now `scuba.md`, `.scuba-manifest`, and `.scuba/`. Because the installer is append-only and reads only the new manifest, upgrading from such a build needs a one-time manual cleanup:
1. Delete the files the old installer left (`~/.claude/.orchestration-manifest`, the skill/agent files it had installed, and `~/.claude/orchestration.md`), then re-run `bash install.sh`.
2. In `~/.claude/CLAUDE.md`, replace the line `@~/.claude/orchestration.md` with `@~/.claude/scuba.md`.
3. Per project: rename any existing `.orchestration/` control-plane directory to `.scuba/`, or let the chief of staff create a fresh one.

## Enable Agent Teams (manual)
Add the flag to the `env` block of `~/.claude/settings.json`, then restart your terminal. If the file already has an `env` block, just add the line inside it; if the file is new, this whole object is fine:

    { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }

Requires Claude Code v2.1.32 or later (`claude --version`). Verify after restart with `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (should print `1`).

## Conflicting plugins (disable superpowers)
Scuba Stack and the `superpowers` plugin are **mutually exclusive.** Superpowers injects a `using-superpowers` instruction whose `<SUBAGENT-STOP>` line tells every spawned subagent to skip skills, which makes Scuba Stack's skill library inert in your workers. Check whether it's enabled:

    grep superpowers ~/.claude/settings.json

If that prints a match, disable it before running Scuba Stack: set `enabledPlugins.superpowers@claude-plugins-official` to `false` in `~/.claude/settings.json` (or remove the plugin entirely), then restart your terminal.

## Enforcement hook
The installer wires one `PreToolUse` hook (`scuba-guard.sh`) into `~/.claude/settings.json`. Like the Agent Teams flag, **hooks load at session start, so it activates only after you restart the terminal**. What it enforces:
- **Worktree isolation** — code `Write`/`Edit`/`MultiEdit`/`NotebookEdit` outside the calling agent's own worktree is denied (writes to any `.scuba/` path and to `/tmp` are allowed; from the top-level session, `.md`/operator-doc and `.scuba/` writes are allowed but tracked code writes are denied — the lead dispatches, it does not build).
- **Never-draft PRs** — `gh pr create --draft` / `gh pr new --draft` are denied (a draft PR is not seen by the external reviewer).

Its limits, briefly: the Bash arm is **best-effort** (a second line of defense, not a sandbox) — it catches the `cd <primary> && git rm`-family and the draft-PR pattern, and its script header enumerates the evasions it does not catch (e.g. `git -C`, `rm -rf`, shell redirection writing to the primary tree); the reliable guard is the file-write containment, which fires however the write is phrased through a tool. It needs `jq` (see Prerequisites). To disable temporarily, remove the scuba entry from `.hooks.PreToolUse` in `settings.json` and restart. See `RUNBOOK.md` for the smoke tests and disable steps.

## Verify
Open Claude Code in a repo and run `/memory`. You should see `~/.claude/CLAUDE.md` loaded. The skills load their one-line descriptions automatically; their bodies load only when triggered.

## Daily use
See `RUNBOOK.md`.
