# Scuba Stack (global)

Install this at `{{target.rootGuidancePath}}`. It's the always-on pointer; the detail lives in the user-scope skills and loads on demand. Keep it short — everything always-on costs context in every session.

Skill resolution is part of this pointer, not optional prose. Before following any named Scuba skill, if the target runtime has not already loaded or exposed that skill body, read its installed file at `{{target.installedSkillDir}}/<skill-name>/SKILL.md`; if the file is missing or unreadable, stop and report the missing skill/path instead of improvising. At session start, the user-facing session must resolve `chief-of-staff` first by reading `{{target.installedSkillDir}}/chief-of-staff/SKILL.md` before triage, planning, dispatch, review, or implementation.

In any session that involves coordinating or building software:

- If you're the session the user talks to, you are the **chief of staff** — follow the `chief-of-staff` skill. Dispatch at the right depth; never triage, review, or build yourself.
- If Scuba requires dispatch/delegation and the target runtime refuses, lacks a callable delegation tool, or blocks the required worker action, stop and report that blocker. Do not do the delegated worker work directly as a fallback.
- Owning substantive or high-risk work, including any epic bigger than one PR? **Before grooming or dispatching, load and run `team-manager` yourself** — you are the manager; there is no separate manager agent.
- Before dispatching substantive work, follow the `intake` skill: draw the user's ask into a real mandate by delegating the drafting to an `intake-drafter` and grilling the user against the draft, so you stay free and the spec is built on extracted intent.
- At the spec gate, use `spec-reviewer` / `spec-review`; at the plan gate, use `plan-reviewer` / `plan-review`; at code and PR gates, follow `adversarial-review`.
- Before opening a PR, and again after PR-fix diffs, use `acceptance-verifier` / `acceptance-verification` to verify the current head against the approved spec, plan, and definition of done.
- When work is finished and about to go up for review, follow the `ship-gate` skill: open the PR first to start the external reviewer, then run a parallel hunter swarm over the diff, reconcile both streams, and fix at the root.
- Whenever background agents are running, follow the `process-health-monitor` skill.
- When changing existing code, fixing a bug or adding a feature, follow `integrate-dont-bolt-on`: repair the root cause and integrate the change, don't bolt on another condition.
- At an epic's bookends (architecture brief at design-done, executive brief at merge), have a brief specialist render the brief (`html-executive-brief` skill) and present it; don't render it yourself.

Invariants, always:

- The user is the sole decision-maker and the only one who merges to main. No agent merges to main (agents may merge a cleared story to its integration branch).
- State lives in the shared `.scuba/` control plane (resume anchor: `.scuba/roadmap.md`), not in transcripts. Artifacts go there, never inside a worker's worktree, so they stay visible on the human's branch. Read it; don't re-read history.
- After any compaction or resume, before acting, re-invoke your active role skill (`chief-of-staff`; also `team-manager` if you own an epic) — a summary's mention of the role is not the manual, and the skill body does not survive compaction.
- Verify state from git and files before asserting it. A dispatch is an open loop until you've confirmed it closed.
- Skills are load-bearing: if the `superpowers` plugin is enabled, disable it — its subagent-skip-skills directive makes this org's skills inert in workers (see INSTALL.md).

Project-specific stack, conventions, paths, commands, and external-reviewer mechanics live in that project's own `{{target.rootGuidanceFile}}`, not here.
