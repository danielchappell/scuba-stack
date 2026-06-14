# Envirogator post-mortem — decisions log

Walking the swarm findings one at a time. Decisions recorded here; implementation deferred until we've talked through them all.

Full analysis: `2026-06-14-envirogator-swarm-eval.md`

---

## Decision 1 — Skill library is inert at runtime (1 of 46 agents loaded a skill)

**Root cause:** superpowers' injected `using-superpowers` instruction has a `<SUBAGENT-STOP>` line telling any subagent to skip skills — so every spawned worker is told, up front, not to invoke skills. Compounding it, scuba's own agent files only *reference* skills ("per `sequence-verifiable-units`") and never instruct the agent to open and follow them. The one agent that did load a skill was the only one whose prompt explicitly ordered it to.

**Decision:**
1. Declare scuba-stack and superpowers **incompatible** — if you run scuba, uninstall superpowers. Document this loudly (install/readme/global pointer).
2. Make every agent definition point hard at its governing skill(s): the agent's first action is to open and follow them; reference/link them explicitly rather than alluding to them.

**Note:** #2 only fires reliably once #1 is done — while superpowers is installed, its "subagents skip skills" line fights the invoke instruction.

**Status:** decided, not yet implemented.

---

## Decision 2 — Worktree isolation is unenforced (a builder corrupted the main tree)

**Root cause:** a code-writer (`a814b36a`, catalog port) `cd`'d out of its worktree into the shared main tree and worked there — `git checkout -b`, `git rm` of Payload files, `npm install` on the main root — then was interrupted, leaving `main` half-migrated and non-building. ≥3 agents did this class of leak. Isolation is a convention; nothing enforces it. Recovery happened by luck.

**Decision:**
1. Write a `PreToolUse` **hook** that blocks any Write/Edit/code-write outside the agent's own worktree, with `.scuba/` whitelisted. The installer sets it up. This is the real fix — a lever the agent can't skip.
2. Secondary/interim: a hard "assert your cwd is inside your worktree before any write" line at the top of the code-writer agents (`senior-implementer`, `bug-fixer`). Weaker (words only), but free.
3. Reject the lazy-worktree-creation idea — it doesn't address the leak (the leak happens during implementation, when the worktree exists anyway).

**Status:** decided, not yet implemented.

---

## Decision 4 — Manager layer: go FLAT (CoS wears the hat), but guarantee the lifecycle still runs

**Context:** there is no `team-manager` agent, and a spawned subagent can't fan out workers. The intended design (manager as a top-level *teammate* peer the CoS talks to) is actually supported by the harness (`TeamCreate`/`SendMessage`) but was never wired — the CoS tried to spawn it as a subagent and fell back to a generic `claude`. At current scale flat is fine; the manager's absence did **not** cause the overnight miss (running-from-memory did).

**Decision:**
1. **Go flat:** the CoS owns the epic lifecycle. No separate manager agent now.
2. **Keep `team-manager` as its own skill** — do NOT move its body into `chief-of-staff` (that bloats the always-loaded path). `chief-of-staff` gets a **one-line bridge**: "when you own an epic, load and run `team-manager` yourself." Lifecycle detail loads on demand, only when actually managing.
3. **Rewrite `team-manager`'s voice:** it is the hat the CoS wears, not a separate agent's job — drop the "you were handed this chunk… surface the integration→main merge *up to the chief of staff*" framing (the CoS *is* the chief).
4. **Keep it on the shelf as the scaling path:** wire a real teammate manager (with an agent file) the day concurrent epics actually exceed what one CoS can hold.

**Making sure the CoS actually loads it (the crux — words alone get skipped under load):**
- **Loud always-on trigger** in the global pointer + the opening of `chief-of-staff`, imperative not advisory: bigger than one PR → before grooming/dispatch, invoke `team-manager`.
- **Real safety net:** Decision 3's hook enforces the manager's *critical outcomes* (integration branch exists, PRs non-draft, story PRs target the integration branch) regardless of whether the skill loaded — so a forgotten load can't reproduce the overnight failure. Softer duties (parallelize independent slices, watch workers) ride on the loud trigger and degrade gracefully.

**Status:** decided, not yet implemented.

---

## Decision 5 — Silent file truncation + architect missing the `Edit` tool

**Root cause:** ~20 agents hit the broken `_safe_eval` (SCM Breeze) shell. The dangerous mode is **heredoc writes** (`cat > file << EOF`) that *silently truncate* — the write reports success but lands partial (a hunter report cut at 3601 bytes; the round-4 architect lost its `§4.0.2` edits). Compounded because **architect agents lack the `Edit` tool** (they have `Write` but not `Edit`), forcing full-file 56–91 KB rewrites that then fell back to heredocs.

**Decision:**
1. **Mandate the `Write`/`Edit` tools for all file deliverables — never Bash heredocs.** Portable fix; protects every agent regardless of whose shell is broken. Add to the agents that produce file deliverables (architect, scribe, hunter, intake-drafter, brief-specialist) and the writing skills.
2. **Grant `architect` the `Edit` tool** (`agents/architect.md` frontmatter `tools:`) so revisions are surgical, not full-file rewrites.
3. (Owner-side, optional) repair/uninstall SCM Breeze — but #1 is the fix that doesn't depend on it.

**Status:** decided, not yet implemented.

---

## Decision 6 — The control plane isn't durable (mirror blocked silently)

**Root cause:** off-machine durability is a git push to the `scuba-state` branch. Overnight that push was **blocked** (CoS scoped the scribe read-only) and reported as a one-line footnote — so the off-machine copy never updated all night. Because `.scuba/` is deliberately self-ignored in the target repo, with no mirror it lives only on local disk (a `git clean -fd` would erase the resume anchor). Tension: durability needs a git write, but sessions are often run read-only for safety.

**Decision (`skills/roadmap/SKILL.md` + `agents/scribe.md`):**
1. The mirror is the one write the CoS must explicitly grant scope for — dispatch the mirroring scribe **with git-write**, not read-only.
2. **Never fail silently:** the scribe verifies the push landed (compare remote SHA); if blocked, it surfaces *"durability mirror NOT pushed — state is local-only"* as a visible blocker in the decisions section, not a footnote.
3. Collision-safe + cold-start recipe: create the orphan state branch if missing; never check it out in the primary tree (use the side worktree) — so a 13-worktree concurrent run can't wedge it.

**Status:** decided, not yet implemented.

---

## Decision 7 — Stale closeout ("merge-ready" / "Codex-clean" already false)

**Root cause:** closeout asserts state that's gone stale by the time it's stated. #25 was called merge-ready over **21 open threads** — a GraphQL `first:100` cap hid page 2 (a fresh Codex round); arithmetic (84+16=100) was internally consistent and wrong vs the true 105. "Codex-clean" was asserted on a head SHA Codex had already moved past; `mergeable:null` cache-misses from the list endpoint read as "fine."

**Decision (`skills/ship-gate/SKILL.md`, principle; project `CLAUDE.md`, the `gh`/GraphQL mechanics):** a **definition-of-done the closeout re-verifies LIVE against the current head before declaring anything**:
- Paginate review threads to exhaustion — compare `totalCount` vs nodes returned; never trust a count that lands exactly on the page size.
- Confirm `mergeable` from the **per-PR** endpoint, not the list endpoint (which returns null).
- Pin "clean" to the **current head SHA** — if the head moved, it isn't clean until re-checked.
- Principle in the skill: *verify live, paginate, pin to head SHA, never trust a cached count.*

**Status:** decided, not yet implemented.

---

## Decision 8 — Add a `steward` agent (PR closeout has no home)

**Root cause:** the most common task all night was PR stewardship — rebase, paginate + triage review threads, root-fix-or-defer, resolve, re-verify on an isolated DB, write the control-plane report. No agent owns it, so it was dispatched as `bug-fixer` (one steward session touched zero code), and the protocol was re-specified from scratch in every task prompt.

**Decision:** create `agents/steward.md` (Opus — it's judgment/disposition work). Distinct posture from `bug-fixer`: disposition + logistics, not root-cause repair (RED→GREEN doesn't apply to a rebase). It owns the PR-closeout protocol once, encoded — paginated thread triage (per Decision 7's live-verify rules), root-fix-or-defer routing, GraphQL resolve, isolated-DB verify, control-plane report, integration-branch merge of a cleared story (Decision 3). `bug-fixer` stays the root-cause repair specialist the steward/ship-gate hands real bugs to.

Contrast with Decision 4 (manager, declined): the manager couldn't be spawned and the scale isn't needed yet; the steward spawns trivially and is needed constantly.

**Wiring (critical — an unrouted agent is an unused file, cf. brief-specialist):** `chief-of-staff` must name the steward explicitly in its dispatch-depth list ("PR closeout / draining review threads / rebases → `steward`"), and `ship-gate` routes the closeout step to the steward (not `bug-fixer`). General rule: every agent in the pool needs an explicit "reach for this when…" line in `chief-of-staff`, or it never gets invoked.

**Status:** decided, not yet implemented.

---

## Decision 9 — Authority provenance / "fabricated coordinator voice" — DROPPED (false positive)

The swarm flagged the round-6 architect as acting on an authorization absent from its transcript. Verified against the raw log: it was a **single-reader absence-inference, and it's wrong.** The architect's own text reads *"the coordinator's mid-task message claimed the owner removed the constraint…"* — i.e., the CoS DID relay the change via `SendMessage`; the reader missed it. Owner confirms the real sequence (architect went wrong → owner corrected → CoS relayed → all corrected). The propagation channel worked. **No action.** (Lesson for ourselves: swarm absence-of-evidence findings need a raw-log check before they count.)

**Status:** closed, no change.

---

## Decision 10 — Hunter's prescribed fix is advisory; the bug-fixer owns the holistic fix

**Root cause:** the hunter→bug-fixer handoff can carry a prescribed fix direction. A gate-hunt prescribed a regex change that would have *failed open* (security regression); avoided only because that particular bug-fixer independently re-derived it.

**Decision:** a hunter's suggested fix is **advisory** (`agents/hunter.md`). The **bug-fixer owns the fix** — it repairs holistically at the root (`integrate-dont-bolt-on`), never bolts on a prescribed patch on faith, and verifies the fix *direction* empirically (RED→GREEN pinned to the invariant, not the patch — a wrong-direction fix can't go green). Reinforce the advisory-not-order framing in `adversarial-review`/`ship-gate`.

**Status:** decided, not yet implemented.

---

## Decision 11 — HTML briefs: keep them, but define "milestone" = epic, with two bookends

**Root cause:** `brief-specialist` + `html-executive-brief` never fired because "milestone" was undefined. Also, the brief predates the roadmap; the roadmap now owns *live status*, so briefs are no longer for ongoing state.

**Decision — keep briefs, retarget them:**
- **Milestone = an epic.** A brief fires at exactly two bookends, and it's **one document per epic, updated** (not two files):
  1. **Architecture brief** — when the architect's design is done, before build: "how this epic gets built."
  2. **Executive brief** — when the epic is merged: the same doc updated to "the finished chunk."
- **`brief-specialist` renders both states** (architect supplies design content for v1, the merged result for v2; the architect never touches HTML). Wire it into `chief-of-staff` at both bookends, or it goes unused (cf. Decision 8 wiring rule).
- **Lives in `.scuba/briefs/`, never checked in** — for the user only.
- **Surfaced through the roadmap:** completed nodes link their brief; a **"Completed this session"** section collects the session's finished briefs.
- **Anti-staleness is lifecycle-based, not time-based** (a skill has no clock): a brief is surfaced only while its node is on the active roadmap (current epics + "Completed this session"). On roadmap re-anchor (next session / done-work aging out during normal upkeep), completed nodes + their brief links drop off the active roadmap. The file remains in `.scuba/` but is no longer pointed at — **un-surfaced = can't confuse the AI**. File deletion is optional disk hygiene (a scribe can sweep on request). The roadmap stays the single source of *live* truth; briefs are frozen as-of-bookend snapshots (history, per Decision 7).

**Status:** decided, not yet implemented.

---

## Decision 12 — Commit trailer hardcodes Opus — OUT OF SCOPE for the bundle

Sonnet-tier agents (scribe, brief-specialist, researcher) commit with "Co-Authored-By: Claude Opus 4.8". Verified: **scuba sets no commit trailer anywhere** — it comes from the harness / the owner's global commit instruction. Not a bundle fix. Optional owner-side tweak to the global commit instruction if accurate per-model attribution matters.

**Status:** closed, no bundle change.

---

## Decision 13 — All workers run on Opus (no more Sonnet agents) — ✅ DONE

Owner: "change everything to Opus, I don't want Sonnet agents anymore." Flipped `researcher`, `brief-specialist`, `scribe` from `sonnet` → `opus` (the other six were already Opus). Reconciled every doc that described the old split: `CLAUDE.md`, `README.md`, `ARCHITECTURE.md` (heading anchor now `#every-worker-runs-on-opus`), `RUNBOOK.md`, `CONTRIBUTING.md`, and removed the now-obsolete Sonnet-escalation note in `agents/researcher.md`. The CoS/managers stay unpinned (inherit session model) — the "don't launch the lead on Sonnet" warnings are intentionally kept. Installed (25 skills, 9 agents).

**Status:** implemented this session.

---

## Decision 3 — Integration branch + no draft PRs + serial dependent chain  ⭐ TOP PRIORITY

Owner: "one of the very most important things, if not the single most important thing" — alongside getting skills to live. Enforce even if heavy-handed; missing it undermines the entire skill set.

**Root cause:** overnight the dependent pivot stories went up as **draft PRs against `main`**. Draft → Codex doesn't review at all. Against `main` → Codex reviews each interdependent PR against a base missing the others' changes, producing phantom "broken" comments, churn, and real review cost.

**The model (decided):**
1. **Independent slices** → parallel, each its own PR into the **integration branch**.
2. **Dependent slices** → serial: one PR open at a time → burn down its comments → **merge into the integration branch** → start the next on top. Never a simultaneous stack of dependent PRs. Codex always reviews against a base that already contains the dependencies.
3. The **integration branch is the single assembly point**, created at groom time before any story PR. Only the user merges integration→main.
4. **PRs are never draft.** Draft = no external review.

**Enforcement (heavy-handed is fine here):**
- Hook blocks `gh pr create --draft`.
- The integration-branch + serial-dependent + never-draft rules inlined loudly where guaranteed read (CoS skill + the PR-opening/steward agent), reinforced in `ship-gate`. Story PRs target the integration branch, not main.

**Status:** decided, not yet implemented.
