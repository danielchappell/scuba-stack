# Contributing to Scuba Stack

Thanks for your interest. Scuba Stack is a body of prompt discipline — skills and agent definitions for Claude Code — not an application. There's no build and no test suite; the "code" is Markdown plus one bash installer. That makes contributing approachable, and it makes *clarity of prose* the main quality bar.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE) (inbound = outbound). Only contribute text you wrote or have the right to contribute under MIT. **Do not paste prose from other projects.** Scuba Stack is independently written; keep it that way. If you're adapting an idea from elsewhere, express it in your own words and credit the inspiration in your PR description.

## Project shape

```
global-CLAUDE.md          # the tiny always-on pointer — keep it short
install.sh                # the installer (set -euo pipefail)
skills/<name>/SKILL.md     # a skill is a directory
agents/<name>.md          # an agent is a single file
hooks/<name>.sh           # an enforcement hook (PreToolUse), wired via install.sh
project-template/CLAUDE.md # per-project context template
INSTALL.md, RUNBOOK.md    # operator docs — keep in sync with install.sh
CLAUDE.md, ARCHITECTURE.md # repo guidance and design
```

## Adding or editing a skill

A skill is a folder `skills/<name>/SKILL.md`:

- Frontmatter is **`name` + `description` only** (no `model`, no `tools`).
- `name` **must match the folder name**.
- The `description` is the always-loaded trigger — it's what routes work to the skill. Write it as "Use when…" and make it carry its weight; this is the single highest-leverage line in the file.
- A skill may ship companion files (see `html-executive-brief/template.html`).

## Adding or editing an agent

An agent is a single file `agents/<name>.md` with frontmatter `name`, `description`, `tools`, `model`:

- The `description`'s "Use when…" drives dispatch.
- `model` pins the worker's tier — **every worker runs on Opus** (see [ARCHITECTURE.md](ARCHITECTURE.md#every-worker-runs-on-opus)). The chief of staff and managers are intentionally unpinned (they inherit the session model).

## Adding or modifying a hook

A hook is an executable script under `hooks/` that Claude Code runs at a tool lifecycle event (currently one `PreToolUse` guard, `scuba-guard.sh`):

- Make it executable and commit it executable (`chmod +x`); the installer also re-chmods on copy.
- Fail **open** on infrastructure gaps (missing `jq`, unreadable input): warn on stderr and `exit 0`. A guard that bricks every tool call on a missing dependency is worse than no guard. Containment denials themselves are **fail-loud** — name the resolved paths in the reason.
- Deny by emitting the full `hookSpecificOutput` object (including `hookEventName`) and exiting 0 — not a bare `exit 2`, so the reason reaches the agent's context. Allow = exit 0 with no stdout.
- Guard every command that can exit nonzero under the script's own `set -euo pipefail` (`jq` with `// default`, never `jq -e`; `git ls-files` in a captured-`if`; `realpath` only on existing paths). An unguarded nonzero exit aborts the hook before it decides — which fails open silently.
- `install.sh` wires it: it copies `hooks/*` (skipping `test-*` fixtures), records `hook:<name>`, and for the enforcement hook merges one `.hooks.PreToolUse` entry into `~/.claude/settings.json` via **temp-then-`mv`** (never `jq f settings.json > settings.json`), idempotently and jq-gated. If you add a *new* hook that needs its own settings entry, follow that same temp-then-`mv` / symmetric-cleanup / `// []`-default discipline.
- Ship a standalone fixture runner (`hooks/test-<name>.sh`) that pipes sample event JSON in and asserts the decisions, since hooks can't be self-tested in the session that edits them (they load at restart).

## The naming contract

Skills and agents reference each other **by bare name** (e.g. `integrate-dont-bolt-on`, `intake-drafter`). Those names are a contract. If you rename one, update **every** reference across `skills/`, `agents/`, and `global-CLAUDE.md` in the same change, then reinstall. A dangling cross-reference is a defect.

## Keep the always-on pointer tiny

`global-CLAUDE.md` is the only text loaded in every session, so every line costs context everywhere. Resist adding to it — put detail in a skill that loads on demand. A PR that grows the pointer needs to justify the per-session tax.

## Migrations are events, not steady state

Skills and agents describe the *current* world only. Never add a version-compat or fallback branch ("if the old `board.md` exists, convert it…") to a skill, an agent, or `global-CLAUDE.md` — that taxes every session forever and rots as versions pass. Steady-state init must be idempotent and version-agnostic ("create X if absent"), not a compat ladder. One-time migrations live in the installer (user scope) or a dated `INSTALL`/`RUNBOOK` upgrade note (per-project state); tag each with a removal condition and prune it once no one is on the old version.

## House style

Write the way the engineering-principle skills preach. In particular:

- **`minimize-reader-load`** — code and prose are read far more than written; reduce what a reader must hold in their head.
- **`integrate-dont-bolt-on`** — fix root causes and fit changes into the design; don't accrete conditions or special cases.
- **`subtract-before-you-add`** — the best change is often a removal; check whether unifying or deleting gets you there first.

Match the terse, essayistic voice of the existing skills. Skip diagrams-for-decoration and filler.

## Testing your change

There's no automated suite, but before opening a PR:

1. `bash -n install.sh` — syntax-check the installer if you touched it.
2. `bash install.sh` — confirm it runs and prints the expected skill/agent/hook counts.
3. If you touched a hook, `bash hooks/test-scuba-guard.sh` — confirm every allow/deny fixture passes.
4. Restart your terminal and confirm the change is live (e.g. `/memory` shows the pointer; the skill/agent/hook triggers as intended). Remember: edits here are inert in live sessions until reinstall + restart.
5. If you changed installer behavior or the role model, update [INSTALL.md](INSTALL.md) and [RUNBOOK.md](RUNBOOK.md) in the same PR.

## Pull requests

- One coherent change per PR. Describe what it changes and why.
- If it touches the installer, say what it touches under `~/.claude` and confirm it stays surgical (never overwrites a user's own files).
- Note any new cross-references or renames so reviewers can check the contract.
