# Architecture

Scuba Stack is split into a platform-neutral core and target-specific projections.

## Core

The core defines the operating model:

- A user-facing chief of staff coordinates work and keeps the user channel free.
- Manager mode owns larger chunks, slices work, monitors workers, and runs quality gates.
- Workers are narrow roles: design, grooming, implementation, bug fixing, review hunting, PR closeout, research, brief rendering, and roadmap bookkeeping.
- State lives in `.scuba/`, with `.scuba/roadmap.md` as the resume anchor.
- Quality is structural: specs, plans, and diffs pass through fresh adversarial review until CLEAN.

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
- The neutral pointer becomes the target's global guidance file.
- Neutral agents render into the target's agent format.
- Hook policy becomes a target adapter only when the target hook contract is verified.

Current targets:

- Claude: Markdown agents, concrete tool lists, `model: opus`, and a verified `PreToolUse` hook adapter.
- Codex: TOML custom agents, `gpt-5.5` high-reasoning profile, skills installed under `~/.agents/skills`, and hook policy documented but not enforced.

## Installer

`install.sh` renders first, installs second.

1. `scripts/render-target.mjs <target> <out-dir>` creates a target bundle.
2. The installer removes files recorded in the previous target manifest.
3. It copies rendered skills, agents, pointer, and verified hook adapters.
4. It wires the target root guidance using the target manifest's root mode: Claude appends one import line if absent, while Codex maintains a marked Scuba block.
5. For Claude only, it surgically merges the hook entry into settings with temp-then-`mv`.

This preserves the original safety property: the installer touches only Scuba-owned files and never overwrites the user's own guidance.

## Why Profiles

Concrete model names and tool names are not universal. A neutral worker role says it needs `model_profile: high_judgment` and `tool_profile: code_writer`; target manifests decide whether that means Claude Opus with `Write/Edit/Bash`, Codex `gpt-5.5` high reasoning, or another platform's equivalent.

## Hook Boundary

Hook behavior is portable as policy, not as an executable. Event names, input JSON, deny output, trust review, and worktree layout differ by platform. Every hook adapter must have:

- a target-specific implementation under `targets/<target>/hooks/`;
- standalone fixtures;
- a live smoke test proving the hook fires in the relevant worker/subagent context.

Until then, that target should ship policy-only hook documentation.
