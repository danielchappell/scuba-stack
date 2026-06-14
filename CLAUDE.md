# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is the **source bundle** for **Scuba Stack** — a multi-agent orchestration org for Claude Code, distributed as skills + agent definitions + a tiny always-on pointer. It is not the running system; it is what gets *installed into* `~/.claude` (user scope) by `install.sh`. Editing files here changes nothing until the installer copies them into `~/.claude` and the terminal restarts.

There is no application, build, or test suite. The "code" is Markdown (skill bodies, agent prompts) plus one bash installer.

Self-referential gotcha: the rules currently governing your session were almost certainly installed *from this repo*. When you edit a skill or agent here, you are editing your own (installed) operating manual — but the change is inert in live sessions until `bash install.sh` runs and terminals restart.

## Commands

- `bash install.sh` — install or update. Idempotent; re-run anytime. Run after any change to `skills/`, `agents/`, or `global-CLAUDE.md` to apply it. It prints the skill/agent counts on success.
- Enable Agent Teams (one-time, manual, not done by the installer): add `{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}` to `~/.claude/settings.json`, restart the terminal. Requires Claude Code v2.1.32+.

There is no linter or test configured. `install.sh` uses `set -euo pipefail`.

## How the installer works (and why edits must respect it)

`install.sh` is **manifest-driven and surgical** — it touches only the org's own files and never the user's other skills, agents, or personal `CLAUDE.md` content:

1. Reads the previous manifest (`~/.claude/.scuba-manifest`) and removes exactly the skills/agents it installed last time. This is the *only* way renamed or deleted skills get cleaned up — without the manifest, stale files would linger.
2. Globs `skills/*/` and `agents/*.md`, copies each into `~/.claude`, and writes the new manifest. **New skills and agents are auto-discovered by these globs — no registration step exists or is needed.** A skill is a directory; an agent is a single `.md` file.
3. Installs `global-CLAUDE.md` as `~/.claude/scuba.md` and ensures `~/.claude/CLAUDE.md` contains the single import line `@~/.claude/scuba.md`. This is **append-only**: it adds the line once if absent and never overwrites the user's file, backing it up to `~/.claude/CLAUDE.md.scuba-bak.<timestamp>` before that single edit.

Implication: to add a capability, add a `skills/<name>/SKILL.md` folder or an `agents/<name>.md` file — the installer picks it up. To rename or remove one, do it here and re-run the installer; the manifest handles cleanup on the *next* install.

## Architecture: the role hierarchy

The system is a layered org. Understanding it requires reading `global-CLAUDE.md` together with the role skills (`chief-of-staff`, `team-manager`) and the agent files.

- **`global-CLAUDE.md`** is the always-on pointer (installed as `~/.claude/scuba.md`, imported by one line). It is deliberately tiny because everything always-on costs context in *every* session. Detail lives in skills, which load on demand. **Keep this file short** — adding to it taxes every session; put detail in a skill instead.
- **Skills load lazily**: a skill's `description` frontmatter is always in context (it's the routing/trigger text); the body loads only when the skill is invoked.
- **Roles**, top to bottom: the **chief of staff** (the single session the user talks to; dispatches, never builds/triages/reviews itself) → **team managers** (own a chunk end-to-end, spawn workers, run the review loop) → **workers** (the agents in `agents/`).
- **State** lives in the shared `.scuba/` control plane in the primary working tree, with `.scuba/roadmap.md` as the resume anchor — never in transcripts, and never inside a worker's worktree (so it stays visible on the human's branch). Skills repeatedly enforce: read the roadmap, verify state from git/files, don't re-read history.
- **Lifecycle**: `intake` (draft mandate → grill user) → spec → plan → build, with `adversarial-review` gating every spec/plan/code gate → `ship-gate` for PR/review → milestones rendered via `html-executive-brief`. `process-health-monitor` runs whenever background agents are live.

### Two families of skills

- **Orchestration / role skills** — the operating system: `chief-of-staff`, `team-manager`, `intake`, `adversarial-review`, `ship-gate`, `process-health-monitor`, `roadmap`, `arena`, `html-executive-brief`.
- **Engineering-principle skills** — the "how to think" library the discipline references: `integrate-dont-bolt-on`, `boundary-discipline`, `foundational-thinking`, `experience-first`, `type-system-discipline`, `minimize-reader-load`, `laziness-protocol`, `subtract-before-you-add`, `sequence-verifiable-units`, `exhaust-the-design-space`, `redesign-from-first-principles`, `build-the-lever`, `outcome-oriented-execution`, `make-operations-idempotent`, `migrate-callers-then-delete-legacy-apis`, `separate-before-serializing-shared-state`.

### The agents (worker pool, `agents/`)

Each is a subagent type with `name`, `description`, `tools`, and a pinned `model`:

- `architect` (opus) — designs spec/plan; does not build.
- `groomer` (opus) — cuts an epic into small, independently-shippable slices (per `sequence-verifiable-units`); does not design or build.
- `hunter` (opus) — fresh independent adversarial finder; runs the touched tests in its own worktree (not read-only), enumerates the whole class with its shared root, returns CLEAN-or-findings, never fixes.
- `intake-drafter` (opus) — drafts the mandate the chief of staff grills against.
- `senior-implementer` (opus) — builds planned implementation against an approved plan.
- `bug-fixer` (opus) — solves bugs and reconciles review/PR findings holistically (root cause, not symptom); routed real bugs by the steward at the gate, replies with the fixing commit.
- `steward` (opus) — owns PR closeout: rebases, paginates/triages review threads, resolves, re-verifies live, merges a cleared story to its integration branch; routes real bugs to the bug-fixer.
- `researcher` (opus) — de-risks one specific unknown.
- `brief-specialist` (opus) — renders the milestone brief from the control plane.
- `scribe` (opus) — keeps `.scuba/roadmap.md` current so the chief of staff never blocks; reconciles status and runs the durability mirror; never writes code or decides.

### Every worker runs on Opus (a load-bearing invariant)

Every worker agent runs on **Opus** — `architect`, `groomer`, `hunter`, `intake-drafter`, `senior-implementer`, `bug-fixer`, `steward`, `researcher`, `brief-specialist`, and `scribe`. Judgment and code-writing obviously demand it; the support roles (gathering, rendering, roadmap bookkeeping) run on Opus too, because a cheaper tier anywhere in the org risks a weaker read the rest of the system then has to catch — not a trade worth making. The two code-writers split by posture: `senior-implementer` executes an approved plan; `bug-fixer` investigates and repairs holistically. The `steward` owns PR closeout (disposition and logistics — rebase, thread triage, resolve, re-verify, merge) and routes the real bugs it finds to the `bug-fixer`; its disposition judgment is Opus work too. Worker models are pinned in agent frontmatter. **The chief of staff and managers are deliberately *not* pinned** — they run as the launched session and its teammates, inheriting the session model. Launching the lead on Sonnet silently downgrades the entire org. Always start the lead session on Opus.

## Conventions when editing

- **Skill**: a folder `skills/<name>/SKILL.md`. Frontmatter is `name` + `description` only (no `model`/`tools`). The `name` must match the folder name. The `description` is the always-loaded trigger — write it as "Use when…" so routing fires correctly; it carries the dispatch weight. A skill may ship companion files (e.g. `html-executive-brief/template.html`).
- **Agent**: a file `agents/<name>.md` with frontmatter `name`, `description`, `tools`, `model`. The `description`'s "Use when…" drives dispatch; the pinned `model` sets the worker's tier.
- **Cross-references are by bare name.** Skills and agents reference each other by their `name` (e.g. `integrate-dont-bolt-on`, `intake-drafter`). Those names are the contract — renaming one means updating every reference across `skills/`, `agents/`, and `global-CLAUDE.md`, then re-running the installer.
- **Keep operator docs in sync**: `INSTALL.md` and `RUNBOOK.md` describe the installer's behavior and daily operation; update them when `install.sh` or the role model changes.
- **`project-template/CLAUDE.md`** is the per-project template (stack, paths, commands, external-reviewer mechanics, project invariants). The global org rules must *not* be repeated into project CLAUDE.md files — that's the whole point of the user-scope install.

## Invariants (from `global-CLAUDE.md`, true everywhere)

- The user is the sole decision-maker and the only one who merges to main. Agents may merge a cleared story into its epic's integration branch; the integration-branch→main merge is always the user's.
- State lives in the shared `.scuba/` control plane (resume anchor `.scuba/roadmap.md`), not transcripts. Read it; don't re-read history.
- Verify state from git and files before asserting it. A dispatch is an open loop until confirmed closed.
