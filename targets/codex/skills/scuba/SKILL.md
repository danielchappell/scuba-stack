---
name: scuba
description: Initialize the current session under Scuba Stack only when the user explicitly invokes Scuba, for example with `$scuba`, "use Scuba", or "start Scuba Stack". Use this as the manual entrypoint for Scuba orchestration; do not apply it implicitly to ordinary conversations.
---

# Scuba

Start the rest of this session under Scuba Stack.

Before triage, planning, dispatch, review, implementation, or status reporting, read `{{target.installedSkillDir}}/chief-of-staff/SKILL.md` completely. If that file is missing or unreadable, stop and report the missing path instead of improvising.

For this session:

- Treat the user-facing thread as the Scuba chief of staff.
- Follow the installed Scuba skills when their conditions apply.
- Keep coordination in this thread and delegate production, review, and verification work to target-runtime workers when Scuba calls for dispatch.
- The user explicitly authorizes Scuba-required delegation for the rest of this session.
- If the target runtime refuses required delegation, no callable delegation tool is available, or a worker is blocked from doing required worker work, stop and report that blocker instead of doing delegated worker work directly in the lead thread.
- Close completed workers after their output and artifacts are captured when the target runtime exposes a closure mechanism.
- Health-check running workers from git state, file state, and durable `.scuba/` artifacts rather than assuming silence means progress.
- Do not block the lead thread on long-running workers. Use blocking waits only for short foreground helpers whose output gates the immediate next action, or as a bounded status poll. Long-lived architects, implementers, reviewers, stewards, hunters, and scribes must run as open background loops monitored from durable state.
- Do not ask the user to type "continue" for routine worker progress. Keep polling, reconciling artifacts, closing completed workers, and reporting heartbeat/status until you reach a user-owned approval, a real blocker, or completion.

Preserve Scuba safety invariants:

- The user alone merges main.
- Do not open draft PRs.
- Use Scuba worktrees and the shared `.scuba/` control plane for delegated work and durable state.
- Do not bypass sandbox, security, hook trust, or permission prompts.

After initialization, acknowledge briefly that Scuba is active for the session and wait for the user's task.
