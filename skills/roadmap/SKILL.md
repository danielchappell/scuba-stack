---
name: roadmap
description: The single state-of-the-world document the chief of staff keeps current and reads first on every resume — a Mermaid stage-tagged tree of every in-flight thread, linking to the artifacts and per-thread status each one needs to recover. Use when initializing or updating orchestration state, on every monitor tick, and to recover after a lost session. The roadmap is the resume anchor; the per-team files are the detail. Make sure to keep it current as work moves, delegating the typing to a scribe rather than blocking on it.
---

# Roadmap

The roadmap is the state of the world: one tree that says what every thread is, what stage it's in, and exactly where to pick it up. It is the resume anchor — the chief of staff reads it first on every new session and keeps it current as work moves. Everything else (specs, plans, statuses, briefs) hangs off it. It replaces a flat checkpoint: a fresh chief of staff with no transcript, or a human glancing at it, should understand the whole world from this one file.

## Control plane, not code plane

Orchestration state has to be visible to the human on their own branch and to a fresh chief of staff with no history. Code is isolated in worktrees; state must not be, or it scatters across branches no one checks out. So there is **one shared `.scuba/` directory in the primary working tree, and every agent writes its orchestration artifacts there by absolute path — never into its own worktree.** Code goes to the worktree branch; the spec, plan, status, decisions, and brief go to `.scuba/`. Doc-only agents (architect, researcher, intake-drafter, brief-specialist) need no worktree at all; only the code-writers do. This is `separate-before-serializing-shared-state` applied to the org's own state.

## The document

`.scuba/roadmap.md` is built by **copying `template.md` verbatim and filling in the threads** — never by authoring a roadmap from scratch. It has three sections, always in this order (see `example.md` for a filled one):

- **Now active** — one or two lines per currently-moving thread: what's happening *right now*, each linking to its `status.md`. The human's at-a-glance status report.
- **Decisions waiting on me** — pinned near the top; every open call that needs the user, one line each with a context link. Never bury a decision in the tree.
- **Roadmap** — a **Mermaid `flowchart TD`** tree (renders as a real diagram on GitHub and in any mermaid-aware preview). Each node is a thread that `click`s through to its current artifact, and the artifacts chain forward — **spec → plan → brief**: the roadmap links to the spec, the spec to its plan, and a **completed (✅) epic node `click`s through to its brief at `.scuba/briefs/<epic>.html`** (the v1 architecture brief written at design-done, updated to the v2 executive brief at merge — per `html-executive-brief`).

### The frame is frozen; only the threads vary

The roadmap looks identical in every project and every session except for the one thing that legitimately differs: the actual threads and their stages. Everything around that is a fixed frame you copy from `template.md` and never re-author:

- **Header line, the three section headings and their order, and the closing caption** — byte-for-byte from the template.
- **The whole `classDef` block — all eight classes, in the template's order, every time.** Never prune an unused class, never reorder them, never change a colour. A stage transition then never touches the classDef block; it only swaps a node's emoji and `:::class`.
- **Shapes** — the root is the only stadium node `([...])`; every initiative and thread is a rectangle `[...]`. No other shapes.

The only edits you make live inside the tree: add, remove, relabel, and re-link nodes and edges. Every node follows one grammar, no choices:

```
ID[<emoji> <label>]:::<stage>      +      click ID "<artifact-path>" "<hint>"
```

where the emoji and `:::<stage>` always agree, from the fixed mapping (🟡 spec · 🔵 plan · 🟢 execution · 🔎 review · ⛔ blocked · ✅ done · 💤 parked). Same state of the world in, same markup out — so two sessions looking at the same threads produce the same file.

**Surfacing the session's finished briefs.** Collect the session's completed epics in a **"Completed this session" grouping inside this same tree** — a `subgraph "Completed this session"` (or a sibling cluster) that holds the session's existing `:::done` nodes, each still clicking through to its `.scuba/briefs/<epic>.html`. This grouping is purely a tree-internal edit and is bound by the frozen frame: it **reuses the existing ✅ done stage and `done` class** (a `subgraph` is a Mermaid container, not a node shape and not a `classDef`), so it is **not** a fourth section, **not** a ninth `classDef` class, and **not** a change to `template.md`. The three section set and order, the eight-class `classDef` block, the header, and the caption stay byte-for-byte from the template.

**The roadmap is the index, not the detail.** The per-thread recovery fields — branch, worktree, last commit SHA, next step, blocker — live in each thread's `teams/<team>/<thread>.status.md`, so the tree stays scannable while recovery still has every field it needs. Keep it for the human's glance: they read this instead of asking you.

## The chief of staff owns it; never blocks on it

The chief of staff keeps the roadmap current as part of the monitor tick it already runs (per `process-health-monitor`): read each thread's real state from git and files, fold it into the tree. That's cheap and not extra blocking. When a pass is heavy — reconciling many agents' statuses into the tree, or running the durability mirror — it dispatches a `scribe` to do the typing while it stays free. It owns the roadmap's correctness whether it updates it itself or delegates; it never lets the roadmap go stale and never blocks on keeping it fresh.

## Durability and recovery

The live `.scuba/` survives a crash, an API outage, or an archived conversation because it's a real directory in the primary tree. To survive losing the machine, it is mirrored to a **per-user state branch** — `scuba-state/<git-user-slug>` (slugged from `git config user.email`, so distinct users on a shared clone don't clobber each other's state) — an orphan branch holding only `.scuba/`, maintained through a side worktree. The **chief of staff dispatches a `scribe` to push this mirror every heartbeat**, so the off-machine copy is never more than one tick stale; that recurring push is the chief of staff's cadence to own, not something the ephemeral scribe schedules itself.

The mirror is the **one write the chief of staff must grant scope for**: dispatch the mirroring scribe **with git-write permission, never read-only**. A read-only scribe silently refuses the push and the off-machine copy goes stale — that is the overnight failure, where the live `.scuba/` kept moving while its mirror sat frozen and no one knew.

**Verify the push landed, never fail silent.** After pushing, the scribe confirms the push by SHA — compare the local mirror SHA against the remote (`git ls-remote` / remote rev-parse) and require them to match. If it did not land — blocked, rejected, offline, or the scribe was scoped read-only — surface **`durability mirror NOT pushed — state is local-only`** as a visible blocker in the roadmap's "Decisions waiting on me" section, **never a footnote**. A silently-stale mirror reads as durable and isn't; the loud blocker is what makes that failure recoverable.

**Collision-safe and cold-start.** Create the orphan state branch if it's missing (cold start). **Never check the state branch out in the primary tree** — always the side worktree — so a many-worktree concurrent run can't wedge it: checking the state branch out in the primary tree empties the code index for every other agent reading there (eval N11). The side worktree is the only place the mirror is ever materialized.

Recovery is a **re-dispatch, not a reconnect** — a killed worker can't be reattached. Fetch, restore `.scuba/` from the branch, read `roadmap.md`, and for each non-terminal thread: verify its worktree still exists and its branch head matches the recorded last SHA, then spawn a *fresh* worker in that thread's role with a mandate built from its `status.md` — goal, `next` step, worktree. (This is why every thread's status keeps a current `next`.) The exact git recipe is operator mechanics — see the repo's `RUNBOOK`/`CLAUDE.md`.

**Brief lifecycle trim (not a timer).** A brief is surfaced only while its node is on the active roadmap (current epics plus the "Completed this session" grouping). On re-anchor — the next session, or done-work aging out during normal upkeep — completed nodes and their brief links drop off the active tree; the `.scuba/briefs/` file remains but is no longer pointed at. Un-surfaced is harmless: a brief nothing links to can't confuse the AI. File deletion is optional disk hygiene a scribe can sweep on request — never a timer; a skill has no clock.

## On first use

Initialize the control plane if absent, idempotently. **First make it self-ignoring**: create `.scuba/.gitignore` containing a single `*` so the whole control plane is invisible to the target repo's git — the human sees the files on their branch, but `git add`/commit never sweeps them into code commits. (This is the gitignored precondition the rest of the design rests on; the durability mirror's `git add -f` is what overrides it on the state branch.) Then create `.scuba/roadmap.md` from `template.md`, plus `.scuba/teams/` and `.scuba/briefs/`. If it already exists, read it and carry on.
