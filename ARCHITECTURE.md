# Architecture

Scuba Stack is split into a platform-neutral core and target-specific projections.

## Core

The core defines the operating model:

- A user-facing chief of staff coordinates work and keeps the user channel free.
- Manager mode owns larger chunks, slices work, monitors workers, and runs quality gates.
- Workers are narrow roles: design, grooming, implementation, bug fixing, review hunting, PR closeout, research, brief rendering, and roadmap bookkeeping.
- State lives in `.scuba/`, with `.scuba/roadmap.md` as the resume anchor.
- Quality is structural: specs pass through `spec-reviewer`, plans pass through `plan-reviewer`, built work passes through `acceptance-verifier`, and diffs/PRs pass through fresh adversarial hunters until CLEAN.

The core source files are intentionally target-neutral:

- `core/pointer.md`
- `skills/*/SKILL.md`
- `agents/*.md`
- `core/hooks/*.policy.md`
- `project-template/TEMPLATE.md`

## Target Translation

Each target manifest maps the neutral concepts to a concrete runtime:

- `model_profile` values become platform model settings.
- `tool_profile` values become platform tool lists, built-in agent postures, or equivalent capabilities.
- The neutral pointer becomes the target's global guidance file only for targets that use always-on guidance.
- Neutral agents render into the target's agent format.
- Target-owned skills render after neutral skills when a runtime needs an entrypoint or adapter skill that must not become shared core behavior.
- Target-owned prompts render only for targets that declare them.
- Hook policy becomes a target adapter only when the target hook contract is represented by target-specific fixtures and install status is truthful.

Current targets:

- Claude: Markdown agents, concrete tool lists, `model: opus`, and a verified `PreToolUse` hook adapter.
- Codex: TOML custom agents, `gpt-5.5` extra-high-reasoning profile, skills installed under `~/.agents/skills` including the manual `$scuba` entrypoint, no global Scuba root guidance, and a Codex-native `PreToolUse` adapter installed through `~/.codex/hooks.json` pending user trust.

## Installer

`install.sh` renders first, installs second.

1. `scripts/render-target.mjs <target> <out-dir>` creates a target bundle.
2. The installer removes files recorded in the previous target manifest.
3. It copies rendered skills, agents, optional target prompts, optional pointer, and verified hook adapters.
4. It wires or clears target root guidance using the target manifest's root mode: Claude appends one import line if absent, while Codex removes stale Scuba root guidance and stays manual-only.
5. It surgically merges verified hook entries with temp-then-`mv`: Claude into `settings.json`, Codex into `hooks.json`.

This preserves the original safety property: the installer touches only Scuba-owned files and never overwrites the user's own guidance. Codex subagent fan-out is controlled by Codex's own `agents.max_threads`, `agents.max_depth`, and `agents.job_max_runtime_seconds` settings; Scuba documents those knobs but does not rewrite `config.toml` until a safe TOML merge path exists.

Codex uses the installed `scuba` skill as an explicit session initializer. The target does not install global Scuba root guidance or a slash prompt; invoke `$scuba` only in threads that should become Scuba-active.

## Why Profiles

Concrete model names and tool names are not universal. A neutral worker role says it needs `model_profile: high_judgment` and `tool_profile: code_writer`; target manifests decide whether that means Claude Opus with `Write/Edit/Bash`, Codex `gpt-5.5` extra-high reasoning, or another platform's equivalent.

## Hook Boundary

Hook behavior is portable as policy, not as an executable. Event names, input JSON, deny output, trust review, and worktree layout differ by platform. Every hook adapter must have:

- a target-specific implementation under `targets/<target>/hooks/`;
- standalone fixtures;
- a live smoke test proving the hook fires in the relevant worker/subagent context.

Codex additionally has a trust boundary: installing `hooks.json` is not the same as operational enforcement. Non-managed command hooks must be reviewed and trusted in the target runtime before they can be treated as active.
