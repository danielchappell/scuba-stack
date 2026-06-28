# Scuba Stack

**A platform-agnostic multi-agent orchestration system for coding agents.**

Scuba Stack turns one user-facing agent into a small, disciplined organization: a chief of staff, manager mode for larger chunks, worker roles, durable control-plane state, and adversarial review gates. The core is neutral Markdown plus target manifests. Installers render that core into the format expected by a specific agent runtime.

## Status

Experimental. The Claude target preserves existing install behavior while adding the new lifecycle gates. Both targets install shared Scuba tools under their target homes. The Codex target installs skills, custom agents, an explicit `$scuba` manual entrypoint skill, and a Codex-native hook adapter. Codex hook status after install is **installed configuration**; it remains **pending trust** until the user reviews/trusts it with `/hooks`, and becomes operational only after trust plus a live denied tool call proves enforcement.

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

- `core/pointer.md` — the tiny always-on pointer rendered only for targets that use global guidance.
- `skills/*/SKILL.md` — neutral skills using the shared Agent Skills format.
- `agents/*.md` — neutral worker roles with `tool_profile` and `model_profile`.
- `core/hooks/*.policy.md` — hook policies, not runtime-specific hook code.
- `project-template/TEMPLATE.md` — neutral per-project guidance template.
- `tools/` — target-neutral executable helpers rendered into target tool directories.

Target-specific translation lives in:

- `targets/claude/manifest.json` and `targets/claude/hooks/`.
- `targets/codex/manifest.json`, `targets/codex/skills/`, and `targets/codex/hooks/`.
- `scripts/render-target.mjs`.

## Targets

| Target | Guidance | Skills | Agents | Tools | Prompts | Hooks |
|---|---|---|---|---|---|---|
| Claude | `~/.claude/CLAUDE.md` imports `~/.claude/scuba.md` | `~/.claude/skills` | Markdown agents in `~/.claude/agents` | `~/.claude/tools` | none | Verified `PreToolUse` adapter installed |
| Codex | none; invoke Scuba manually with `$scuba` | `~/.agents/skills` | TOML custom agents in `~/.codex/agents` | `~/.codex/tools` | none | `~/.codex/hooks.json` entry installed pending `/hooks` trust |

Concrete model and tool choices are target manifest data. The neutral role files name profiles such as `high_judgment` and `code_writer`; renderers map those profiles to each platform.

## Operating Shape

The org has three conceptual layers:

```text
You -> Chief of Staff -> Team Manager mode -> Workers
```

- The chief of staff owns intake, dispatch depth, monitoring, and decisions.
- Manager mode owns an epic end to end, slices it into independently shippable work, and runs review loops.
- Workers perform bounded roles such as `architect`, `spec-reviewer`, `groomer`, `plan-reviewer`, `senior-implementer`, `acceptance-verifier`, `hunter`, `bug-fixer`, `steward`, `researcher`, `brief-specialist`, and `scribe`.
- Codex sessions are ordinary by default. Invoke `$scuba` only in threads that should enter the Scuba operating model.
- Codex subagent caps are configured through Codex's `agents.max_threads`, `agents.max_depth`, and `agents.job_max_runtime_seconds`; Scuba workers should be closed after completion so they do not consume the open-thread cap.

State lives in `.scuba/`, especially `.scuba/roadmap.md`, so work survives compaction, resumes, and parallel worktrees.

## Development

There is no app build. Validate changes with:

```bash
node scripts/test.mjs
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
node scripts/audit-codex-jsonl.mjs --list-recent
bash hooks/test-scuba-guard.sh
bash hooks/test-codex-scuba-guard.sh
```

When adding a new platform, add a target manifest, write any target adapters under `targets/<target>/`, extend the renderer only where necessary, and keep the core files free of platform names.

For Codex Desktop behavior audits, use `node scripts/audit-codex-jsonl.mjs <root-thread-id>` to reconstruct the root thread and descendant subagent sessions from `~/.codex/sessions` and `~/.codex/archived_sessions`. Add `--acceptance` when the audit is a gate; it fails nonzero for missing root JSONL, parse errors, or unreconciled task starts while keeping the report bounded to operational metadata.
