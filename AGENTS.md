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
- `bash hooks/test-codex-scuba-guard.sh` — run the Codex hook fixture tests.
- `bash -n install.sh` — syntax-check the installer.

## Architecture

The core is target-neutral:

- `skills/*/SKILL.md` are neutral skills. Frontmatter is `name` and `description` only.
- `agents/*.md` are neutral worker role definitions. Frontmatter is `name`, `description`, `tool_profile`, and `model_profile`.
- `tools/` contains shared target-neutral executable tools. Targets render it through `manifest.toolDir` and install it through `install.toolDir`.
- `core/pointer.md` is the neutral always-on pointer rendered only for targets that use global guidance.
- `core/hooks/*.policy.md` contains target-neutral hook policy.
- `project-template/TEMPLATE.md` is the neutral per-project guidance template.
- `targets/<target>/skills/*/SKILL.md` are target-owned skills, used only when a runtime needs a wrapper or entrypoint that should not become shared core behavior.

Targets translate the core:

- `targets/claude/manifest.json` maps profiles to Claude tools/models, Markdown agent files, Claude install paths, and the verified Claude hook adapter.
- `targets/codex/manifest.json` plus `targets/codex/skills/` map profiles to Codex custom-agent TOML, manual skill activation, Codex install paths, and the Codex hook adapter installed through `~/.codex/hooks.json` pending `/hooks` trust.
- `manifest.toolDir` is the rendered bundle path for shared tools and must stay inside the target bundle. `install.toolDir` is the installed target-home-relative tool path.
- `scripts/render-target.mjs` is the only renderer. Do not hand-maintain generated target artifacts in user homes.

## Installer Invariants

`install.sh` must remain manifest-driven, surgical, and idempotent.

- It removes only files recorded in the previous target manifest.
- Tool files recorded in `.scuba-manifest` use `tool:<relative-path>` entries relative to the installed target tool dir. A current rendered tool may replace an existing file only when that exact path was claimed by the prior `tool:` manifest entry; otherwise regular files, symlinks, directories, and special nodes at rendered tool paths are preserved by failing closed.
- It never overwrites the user's own root guidance file wholesale. Claude appends one import line if absent; Codex is manual-only and removes stale Scuba managed blocks/imports from prior installs. Back up before changing an existing root guidance file, and do not create new backups when the rendered content is unchanged.
- It installs from a freshly rendered target bundle, not directly from neutral source files.
- Hook settings are merged via temp-then-`mv`; never write `jq ... settings.json > settings.json` or `jq ... hooks.json > hooks.json`.
- Codex hooks are installed only through `~/.codex/hooks.json`, never `~/.codex/config.toml`; installer output must distinguish installed-pending-trust from trusted/operational.

## Editing Conventions

- Keep target specifics out of core prose. Use "target guidance file" instead of `CLAUDE.md` or `AGENTS.md` in neutral skills and agents.
- Use profile names in neutral agents. Do not put concrete model names or platform tool lists in `agents/*.md`.
- Concrete model/tool choices belong in `targets/<target>/manifest.json`.
- Cross-references are by bare skill/agent name. Renaming one means updating every reference across `skills/`, `agents/`, `core/`, target manifests, and docs.
- Keep `core/pointer.md` short. Detail belongs in skills because the pointer is always-on.
- Keep operator docs in sync when install behavior, target layout, hooks, lifecycle gates, review profiles, or role semantics change.

## Current Target Notes

- Claude remains the default target and preserves existing install locations under `~/.claude`.
- Claude installs shared tools to `~/.claude/tools`.
- Codex installs custom agents to `~/.codex/agents`, skills including the manual `$scuba` entrypoint to `~/.agents/skills`, shared tools to `~/.codex/tools`, and the hook adapter to `~/.codex/hooks` with config in `~/.codex/hooks.json`; it does not install global Scuba guidance.

## Invariants

- The user is the sole decision-maker and the only one who merges to main.
- State lives in the shared `.scuba/` control plane, with `.scuba/roadmap.md` as the resume anchor.
- Verify state from git and files before asserting it.
- Substantive work follows the reviewed lifecycle: spec review, user spec approval, grooming when needed, plan review, user plan approval, build, acceptance verification, and ship gate.
