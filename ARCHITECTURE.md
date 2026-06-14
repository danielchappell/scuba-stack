# Architecture

This is the design and the reasoning behind it. [README.md](README.md) is the overview; [CLAUDE.md](CLAUDE.md) is how to work inside this repo; this file is *why the system is shaped the way it is*.

## The problem

A single Claude Code session that both talks to you and does the work is serial by construction. The instant it starts grinding — triaging a backlog, reviewing a diff, debugging — you are blocked, and so is any planning of the next thing. Quality, meanwhile, tends to be a single pass at the end, which misses things one perspective always misses.

Scuba Stack is an answer to both: **keep the executive free so nothing blocks planning, and make quality structural rather than a final step.**

## Principle 1 — the executive never does the work

The session you talk to is the **chief of staff**. Its cardinal rule is *dispatch, don't do*. It does not triage, review, or build — those are precisely the actions that would make it grind and therefore block you. Its only jobs are:

- **Pick the dispatch depth.** A contained task or research goes to a single worker directly. A big or risky chunk goes to an autonomous manager. The rule of thumb: if you'd be tempted to triage or review a chunk yourself, that's exactly when to hand the *whole chunk* to a manager.
- **Monitor everything in flight** (Principle 3).
- **Surface decisions** one at a time, each with a recommendation.

This is enforced culturally by the skill, which lists the concrete tells ("you're about to sort a bug list yourself", "you're about to make a fix because it's quick") and says: stop, hand it down.

## Principle 2 — parallelize everything; the human is the only serial point

Managers and workers run concurrently. The deliberate bottleneck is **you**: there is one human channel, so decisions are brought to you singly and in high-yield rounds, while everything else proceeds behind them. `intake` makes this explicit — drafting is parallelized across `intake-drafter` agents, but the conversation with you is understood to be the real, un-parallelizable bottleneck, so each round must earn its interruption.

## The layered org

```
You  →  Chief of Staff  →  Team Manager  →  Workers
```

- **Depth caps at three levels.** No manager of managers; no worker spawns a team. This keeps the accountability chain legible and the monitoring tractable.
- **Breadth caps at monitorability, not ambition.** The lead only fans out as wide as it can health-check on a single monitoring tick (roughly three teams, five at the absolute ceiling). More parallel agents than you can keep alive is exactly how stalls hide.
- **Managers absorb coordination.** A manager exists to take a chunk's triage and review *off* the chief of staff. Doing that coordination is its job, not a failure; what it must not do is the production work itself.

## The lifecycle and adversarial review

Every substantive chunk moves **intake → spec → plan → build → ship**:

- **`intake`** converts a raw, underspecified ask into a dispatchable mandate (goal, constraints, definition of done, scope, quality bar). It is draft-first: an `intake-drafter` writes a draft with its assumptions made loud, and the chief of staff grills you against it. This is the one gap the rest of the machinery cannot cover — spec/plan/build/review all check work *against the mandate*, never whether the mandate matched what you meant.
- **Grooming.** An epic is cut into small, independently-shippable slices by the `groomer` (per `sequence-verifiable-units`) before build — each slice is its own spec → plan → build → ship cycle on its own branch. A large change shipped as one PR never converges (every fix-push draws another review round on the new code); small slices each go quiet and merge.
- **`adversarial-review`** gates each spec, plan, and code gate. Hunters are **fresh** (not the author, not carrying build context), **independent** (separate agents), and **lensed** (each with a distinct angle). They read the actual code, run the touched tests in their own worktree to prove a finding rather than reason it, cite `file:line`, separate real findings from speculation, and enumerate the whole class — not a few — so one fix can close it. Every finding is classified REAL / DEFERRED / INVALID; the loop repeats until a confirming pass returns zero real findings (CLEAN). Fixes are non-vacuous (red → green → refactor) and test the invariant, not the patch.
- **Front-running an external reviewer.** When a PR bot or similar is in the loop, Scuba Stack does not serialize against its latency. `ship-gate` opens the PR first (starting the bot's clock), runs an internal hunter swarm over the diff *in parallel*, reconciles both streams into one deduped classified worklist, and hands it to the `bug-fixer` to repair the root causes in a single pass. The internal hunters are tuned to the bug *classes* the external one actually validates, so they catch them first.

You give go/no-go at spec and plan. Agents merge cleared slices onto an epic's integration branch; the integration-branch→main merge is yours alone — no agent merges to main.

## State model — the control plane, not the transcript

Transcript memory is unreliable across compaction and resumes, so Scuba Stack never depends on it. And because workers build in isolated git worktrees, state can't live with the code or it scatters across branches no one checks out. So state lives in **one shared `.scuba/` control plane in the primary working tree** — visible to the human on their own branch, and to a fresh chief of staff with no history. Every agent writes its orchestration artifacts there by absolute path; only code goes in the worktrees. (This is `separate-before-serializing-shared-state` applied to the org itself.)

- **`roadmap.md`** — the resume anchor: a **Mermaid** stage-tagged tree indexing every thread, plus a "now active" digest and the decisions waiting on the user. Each node links to its artifacts (which chain spec → plan → brief); the per-thread recovery detail — branch, worktree, last SHA, next step, blocker — lives in its `teams/<team>/status.md`, so the tree stays scannable. The chief of staff reads it first and keeps it current on its monitor tick, delegating heavy reconciliation to a `scribe` so it never blocks (the `roadmap` skill is the format and discipline).
- **`teams/<team>/`** — per-manager working state (`status.md`, `spec.md`, `plan.md`, `decisions.md`).
- **`briefs/`** — rendered milestone briefs.

For durability beyond the local disk, the control plane is mirrored to a per-user orphan branch `scuba-state/<git-user-slug>` (per git email, so distinct users don't collide), pushed every heartbeat by a scribe the chief of staff dispatches. Recovery is: fetch, restore `.scuba/`, read the roadmap, and re-attach to each thread by its branch and last SHA.

Two disciplines fall out of this:

- **Verify, don't assert.** Whether something is blocked, done, test-covered, or P1-vs-P2 is a *fact read from git and files*, not a claim from memory. Conservative gate text ("blocked on X") is a default to question, not obey.
- **Progress must be observable.** Workers commit and push per finding, not in one batch at the end — a batch-push fixer is unmonitorable (its branch head never moves) and loses everything if interrupted. Per-finding pushes give visible progress and cap any loss at one in-flight change.

## Process health — every dispatch is an open loop

A killed or interrupted agent sends no completion message, so trusting silence is how delegated work sits dead for hours. `process-health-monitor` runs a re-arming poll (~10-minute cadence) that judges liveness from **what work produces** — output mtimes, git SHAs, written artifacts, branch/PR state — never from the presence or absence of a notification. A dispatch (or a re-trigger of an external reviewer or CI run) stays an open loop until it is confirmed closed.

## Every worker runs on Opus

This is a load-bearing invariant: every worker agent runs on **Opus** — `architect`, `groomer` (slicing epics), `hunter` (adversarial finding), `intake-drafter`, `senior-implementer` (executing a plan), `bug-fixer` (independent root-cause work), `researcher` (gathering), `brief-specialist` (rendering from the control plane), and `scribe` (keeping the roadmap current).

Judgment and code-writing obviously need it; a fix or a reconciliation of review/PR findings on a cheaper tier buys a tunnel-visioned, bolt-on repair — the opposite of what `ship-gate` and `integrate-dont-bolt-on` exist for. The support roles run on Opus too rather than seed a weaker read anywhere in the org that the rest of the system then has to catch. The two code-writers split by *posture*: the `senior-implementer` executes an approved plan (the plan is the contract), while the `bug-fixer` investigates and repairs holistically (no plan, just a symptom and a system).

Worker models are pinned in agent frontmatter. The chief of staff and managers are **deliberately not pinned**: they run as the launched session and its teammates, inheriting the session model. This is why you must **start the lead session on Opus** — launching on Sonnet silently downgrades the entire org.

## Skills — lazy, triggered, named

A skill is a folder with a `SKILL.md` whose frontmatter is just `name` + `description`.

- **Lazy loading.** A skill's `description` is always in context — it is the routing/trigger text — but the body loads only when the skill fires. This is the mechanism that lets the system carry a large discipline without paying for all of it in every session.
- **Two families.** *Orchestration / role skills* are the operating system (`chief-of-staff`, `team-manager`, `intake`, `adversarial-review`, `ship-gate`, `process-health-monitor`, `roadmap`, `arena`, `html-executive-brief`). *Engineering-principle skills* are the "how to think" library the org references when building (`integrate-dont-bolt-on`, `boundary-discipline`, and the rest).
- **Cross-references are by bare name.** Skills and agents reference each other by `name`. Those names are the contract: renaming one means updating every reference across `skills/`, `agents/`, and `global-CLAUDE.md`, then reinstalling.

## The always-on pointer is deliberately tiny

`global-CLAUDE.md` (installed as `~/.claude/scuba.md`, imported by one line in `~/.claude/CLAUDE.md`) is the only always-on text. Everything always-on costs context in *every* session, so it is kept to a pointer: it names the roles and invariants and defers all detail to the skills, which load on demand. Adding to it taxes every session — detail belongs in a skill.

## The installer

`install.sh` is **manifest-driven, surgical, and idempotent**:

1. It reads the previous manifest (`~/.claude/.scuba-manifest`) and removes exactly the skills/agents it installed last time — the only mechanism by which renamed or deleted items get cleaned up.
2. It globs `skills/*/` and `agents/*.md`, copies each into `~/.claude`, and writes a new manifest. New skills and agents are **auto-discovered** — there is no registration step.
3. It installs the pointer and ensures `~/.claude/CLAUDE.md` imports it. This step is **append-only**: it adds the single import line once if absent, **never overwrites your file**, and backs the file up to `~/.claude/CLAUDE.md.scuba-bak.<timestamp>` before that one edit.

The surgical, append-only design is what makes the installer safe to drop into an existing `~/.claude` that already has the user's own skills, agents, and personal `CLAUDE.md`.

It also copies a `hooks/` directory and merges a single `PreToolUse` entry into `~/.claude/settings.json` (the one place the installer touches that file, via temp-then-`mv` so every other key is preserved, manifest-tracked for symmetric cleanup). This turns two rules that were previously convention — keep code writes inside the agent's own worktree, and never open a draft PR — into a **lever**: an enforcement hook that denies the violating tool call rather than trusting every agent to remember the rule.

## Costs and limits

- A three-team run costs several times a single session, and direct inter-agent messages bill per round trip. The control-plane-first coordination rule is the main cost control.
- Idle teammates gray out and self-terminate; a ~15-minute heartbeat keeps active managers warm.
- It rides Claude Code's **experimental** Agent Teams feature, so behavior tracks that feature's evolution.

## What this is not

It is not an application, an SDK, or a framework you import. It is a body of prompt discipline — skills and agent definitions — installed into Claude Code. Editing a file here changes nothing until `install.sh` copies it into `~/.claude` and terminals restart. A future "precision upgrade" (moving the coordination loop to the Agent SDK for exact heartbeat control) is noted in [RUNBOOK.md](RUNBOOK.md) and deliberately out of scope for this version; the skills and agent definitions would carry straight over.
