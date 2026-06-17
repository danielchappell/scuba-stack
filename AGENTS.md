# AGENTS.md

This file provides guidance when working on this repository. It is the source of truth for repo maintenance; `CLAUDE.md` only points here for Claude-compatible tools.

## What This Repo Is

This is the **source bundle** for **Scuba Stack**: a platform-agnostic multi-agent orchestration system distributed as neutral skills, neutral agent role definitions, target manifests, target renderers, and target installers.

The files here are source. Editing them changes no installed runtime until `bash install.sh <target>` renders and copies the target projection into the user's agent home.

There is no application build. The "code" is Markdown, target manifests, a renderer, a Bash installer, and hook scripts.

## Commands

- `bash install.sh` — install/update the Claude target. This remains the backward-compatible default.
- `bash install.sh claude` — explicitly install/update the Claude target.
- `bash install.sh codex` — install/update the Codex target.
- `node scripts/render-target.mjs claude /tmp/scuba-claude` — render the Claude target without installing.
- `node scripts/render-target.mjs codex /tmp/scuba-codex` — render the Codex target without installing.
- `node scripts/test.mjs` — run static, render, installer idempotency, and hook regression tests.
- `bash hooks/test-scuba-guard.sh` — run the Claude hook fixture tests.
- `bash -n install.sh` — syntax-check the installer.

## Architecture

The core is target-neutral:

- `skills/*/SKILL.md` are neutral skills. Frontmatter is `name` and `description` only.
- `agents/*.md` are neutral worker role definitions. Frontmatter is `name`, `description`, `tool_profile`, and `model_profile`.
- `core/pointer.md` is the neutral always-on pointer rendered into each target's global guidance file.
- `core/hooks/*.policy.md` contains target-neutral hook policy.
- `project-template/TEMPLATE.md` is the neutral per-project guidance template.

Targets translate the core:

- `targets/claude/manifest.json` maps profiles to Claude tools/models, Markdown agent files, Claude install paths, and the verified Claude hook adapter.
- `targets/codex/manifest.json` maps profiles to Codex custom-agent TOML, Codex install paths, and documents that hook enforcement is policy-only until a Codex adapter is verified.
- `scripts/render-target.mjs` is the only renderer. Do not hand-maintain generated target artifacts in user homes.

## Installer Invariants

`install.sh` must remain manifest-driven, surgical, and idempotent.

- It removes only files recorded in the previous target manifest.
- It never overwrites the user's own root guidance file wholesale. Claude appends one import line if absent; Codex maintains a marked Scuba block because Codex does not auto-inline `@file` imports at startup. Back up before changing an existing root guidance file, and do not create new backups when the rendered content is unchanged.
- It installs from a freshly rendered target bundle, not directly from neutral source files.
- Claude hook settings are merged via temp-then-`mv`; never write `jq ... settings.json > settings.json`.
- Codex hooks are not installed until a Codex adapter has standalone fixtures and a live smoke test.

## Editing Conventions

- Keep target specifics out of core prose. Use "target guidance file" instead of `CLAUDE.md` or `AGENTS.md` in neutral skills and agents.
- Use profile names in neutral agents. Do not put concrete model names or platform tool lists in `agents/*.md`.
- Concrete model/tool choices belong in `targets/<target>/manifest.json`.
- Cross-references are by bare skill/agent name. Renaming one means updating every reference across `skills/`, `agents/`, `core/`, target manifests, and docs.
- Keep `core/pointer.md` short. Detail belongs in skills because the pointer is always-on.
- Keep operator docs in sync when install behavior, target layout, hooks, or role semantics change.

## Current Target Notes

- Claude remains the default target and preserves existing install locations under `~/.claude`.
- Codex installs global guidance to `~/.codex`, custom agents to `~/.codex/agents`, and skills to `~/.agents/skills`.
- Codex subagent use requires explicit user intent in current Codex behavior; Scuba's Codex target should describe delegation as an elevated operating mode, not an unconditional override.

## Invariants

- The user is the sole decision-maker and the only one who merges to main.
- State lives in the shared `.scuba/` control plane, with `.scuba/roadmap.md` as the resume anchor.
- Verify state from git and files before asserting it.
