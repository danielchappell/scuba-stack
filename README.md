# Scuba Stack

**A platform-agnostic multi-agent orchestration system for coding agents.**

Scuba Stack turns one user-facing agent into a small, disciplined organization: a chief of staff, manager mode for larger chunks, worker roles, durable control-plane state, and adversarial review gates. The core is neutral Markdown plus target manifests. Installers render that core into the format expected by a specific agent runtime.

## Status

Experimental. The Claude target preserves the original Scuba Stack behavior. The Codex target renders guidance, skills, and custom agents; hook enforcement is policy-only until a Codex hook adapter is implemented and smoke-tested.

## Quickstart

```bash
# Backward-compatible Claude install
bash install.sh

# Explicit target installs
bash install.sh claude
bash install.sh codex

# Render without installing
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
```

## Core Model

The target-neutral source lives in:

- `core/pointer.md` — the tiny always-on pointer rendered into each target.
- `skills/*/SKILL.md` — neutral skills using the shared Agent Skills format.
- `agents/*.md` — neutral worker roles with `tool_profile` and `model_profile`.
- `core/hooks/*.policy.md` — hook policies, not runtime-specific hook code.
- `project-template/TEMPLATE.md` — neutral per-project guidance template.

Target-specific translation lives in:

- `targets/claude/manifest.json` and `targets/claude/hooks/`.
- `targets/codex/manifest.json`.
- `scripts/render-target.mjs`.

## Targets

| Target | Guidance | Skills | Agents | Hooks |
|---|---|---|---|---|
| Claude | `~/.claude/CLAUDE.md` imports `~/.claude/scuba.md` | `~/.claude/skills` | Markdown agents in `~/.claude/agents` | Verified `PreToolUse` adapter installed |
| Codex | `~/.codex/AGENTS.md` contains a managed Scuba block | `~/.agents/skills` | TOML custom agents in `~/.codex/agents` | Policy-only, not installed yet |

Concrete model and tool choices are target manifest data. The neutral role files name profiles such as `high_judgment` and `code_writer`; renderers map those profiles to each platform.

## Operating Shape

The org has three conceptual layers:

```text
You -> Chief of Staff -> Team Manager mode -> Workers
```

- The chief of staff owns intake, dispatch depth, monitoring, and decisions.
- Manager mode owns an epic end to end, slices it into independently shippable work, and runs review loops.
- Workers perform bounded roles such as `architect`, `groomer`, `hunter`, `senior-implementer`, `bug-fixer`, `steward`, `researcher`, `brief-specialist`, and `scribe`.

State lives in `.scuba/`, especially `.scuba/roadmap.md`, so work survives compaction, resumes, and parallel worktrees.

## Development

There is no app build. Validate changes with:

```bash
node scripts/test.mjs
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
bash hooks/test-scuba-guard.sh
```

When adding a new platform, add a target manifest, write any target adapters under `targets/<target>/`, extend the renderer only where necessary, and keep the core files free of platform names.
