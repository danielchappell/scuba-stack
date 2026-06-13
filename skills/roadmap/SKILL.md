---
name: roadmap
description: The single state-of-the-world document the chief of staff keeps current and reads first on every resume — a stage-tagged tree of every in-flight thread with the branch, worktree, artifacts, and last-known state needed to recover it. Use when initializing or updating orchestration state, on every monitor tick, and to recover after a lost session. The roadmap is the resume anchor; the per-team files are the detail. Make sure to keep it current as work moves, delegating the typing to a scribe rather than blocking on it.
---

# Roadmap

The roadmap is the state of the world: one tree that says what every thread is, what stage it's in, and exactly where to pick it up. It is the resume anchor — the chief of staff reads it first on every new session and keeps it current as work moves. Everything else (specs, plans, statuses, briefs) hangs off it. It replaces a flat checkpoint: a fresh chief of staff with no transcript, or a human glancing at it, should understand the whole world from this one file.

## Control plane, not code plane

Orchestration state has to be visible to the human on their own branch and to a fresh chief of staff with no history. Code is isolated in worktrees; state must not be, or it scatters across branches no one checks out. So there is **one shared `.scuba/` directory in the primary working tree, and every agent writes its orchestration artifacts there by absolute path — never into its own worktree.** Code goes to the worktree branch; the spec, plan, status, decisions, and brief go to `.scuba/`. Doc-only agents (architect, researcher, intake-drafter, brief-specialist) need no worktree at all; only the code-writers do. This is `separate-before-serializing-shared-state` applied to the org's own state.

## The document

`.scuba/roadmap.md` is the tree. Start from the bundled `template.md`; don't redesign it. Children nest under parents so the dependency tree is visible, and every node carries what recovery needs:

- **goal** — one line, the outcome.
- **stage** — 🟡 spec · 🔵 plan · ⛔ blocked · 🟢 execution · 🔎 review · ✅ done · 💤 parked.
- **owner** — the manager or worker on it.
- **branch + worktree** — where the code lives.
- **artifacts** — links into `.scuba/teams/<team>/` (spec, plan, status, decisions) and `.scuba/briefs/`.
- **left off at** — last commit SHA, the next step, and any blocker.

Decisions waiting on the user sit in their own section at the top; never bury them in the tree. Keep it scannable — the human reads this instead of asking you, so optimize for their glance, not your convenience.

## The chief of staff owns it; never blocks on it

The chief of staff keeps the roadmap current as part of the monitor tick it already runs (per `process-health-monitor`): read each thread's real state from git and files, fold it into the tree. That's cheap and not extra blocking. When a pass is heavy — reconciling many agents' statuses into the tree, or running the durability mirror — it dispatches a `scribe` to do the typing while it stays free. It owns the roadmap's correctness whether it updates it itself or delegates; it never lets the roadmap go stale and never blocks on keeping it fresh.

## Durability and recovery

The live `.scuba/` survives a crash, an API outage, or an archived conversation because it's a real directory in the primary tree. To survive losing the machine, it is mirrored to a **per-user state branch** — `scuba-state/<git-user-slug>` (slugged from `git config user.email`, so distinct users on a shared clone don't clobber each other's state) — an orphan branch holding only `.scuba/`, maintained through a side worktree. The **chief of staff dispatches a `scribe` to push this mirror every heartbeat**, so the off-machine copy is never more than one tick stale; that recurring push is the chief of staff's cadence to own, not something the ephemeral scribe schedules itself.

Recovery is a **re-dispatch, not a reconnect** — a killed worker can't be reattached. Fetch, restore `.scuba/` from the branch, read `roadmap.md`, and for each non-terminal thread: verify its worktree still exists and its branch head matches the recorded last SHA, then spawn a *fresh* worker in the node's role with a mandate built from the node's goal, `next` step, and worktree path. (This is why `next` is mandatory on every node.) The exact git recipe is operator mechanics — see the repo's `RUNBOOK`/`CLAUDE.md`.

## On first use

Initialize the control plane if absent, idempotently. **First make it self-ignoring**: create `.scuba/.gitignore` containing a single `*` so the whole control plane is invisible to the target repo's git — the human sees the files on their branch, but `git add`/commit never sweeps them into code commits. (This is the gitignored precondition the rest of the design rests on; the durability mirror's `git add -f` is what overrides it on the state branch.) Then create `.scuba/roadmap.md` from `template.md`, plus `.scuba/teams/` and `.scuba/briefs/`. If it already exists, read it and carry on.
