---
name: process-health-monitor
description: Procedure for keeping delegated background work alive. A re-arming poll that health-checks every running agent by git SHA, file mtime, and durable artifacts rather than waiting for completion messages. Use this whenever one or more agents or processes are running in the background and you need to detect stalls and deaths before they cost hours. Make sure to use this whenever you have dispatched background work.
---

# Process Health Monitor

A killed or interrupted agent sends no completion notification. Trusting silence is how delegated work sits dead for hours. So you verify liveness from what work actually produces, on a cadence, for everything in flight.

## The re-arming poll

While anything runs in the background, keep a poll alive on a roughly 10-minute cadence. The mechanism is a background shell poll (`sleep N; check; exit`) that re-invokes you when it exits, so you act on what it found and then re-arm it. A foreground sleep blocks your thread and a worker can't reliably time itself, so this background re-invoke is the way to get a real cadence natively.

## What to check each tick

For every tracked process, judged strongest signal first:

- **Branch / PR state, both directions** — the primary liveness signal. Outbound: has the head SHA moved, did the PR update. **Inbound**: new external-reviewer rounds (read the review *bodies*, not just the count — a fresh round with unread findings is an open loop), mergeability, and commits-behind-base. An idle PR sitting on a waiting review round is a stall you caused, not progress.
- **Durable artifacts** — the things it should have produced by now: git SHAs, written files, queue entries. Their presence is proof of life; their absence after enough time is a stall.
- **Output mtime** — a weak, lagging corroborator, never a verdict on its own. It tracks the agent's *last emission to its transcript*, not its last work, so an agent deep in tool calls or parked waiting on an external reviewer can be fully alive while its `.output` file sits untouched for an hour. Expect identical stale timestamps across agents even for one that is live or already finished. Never declare a stall from mtime alone: corroborate against outbound git state first, and let git state win when the two disagree.

Judge liveness from these, strongest first, never from the presence or absence of a message. A transcript line such as an interruption notice is the tell that an agent was killed rather than finished.

Fold what each tick finds into `.scuba/roadmap.md` so the state of the world stays current (per the `roadmap` skill): that file, plus each thread's branch and last SHA, is what a fresh session recovers from after a crash or a lost conversation. When keeping it current would block you, hand the update to a `scribe` rather than letting the roadmap drift. The tick also pushes the durability mirror to the per-user state branch (via a `scribe`), so a crash never costs more than one tick of off-machine state.

## Every dispatch is an open loop

A dispatch or a re-trigger is open until you have confirmed it closed. Track each as an explicit open watch. This includes external events that send no notification of their own (an outside reviewer, a CI run): poll them to closure too; don't assume they finished.

## When something is dead or stalled

Recover partial work from its branch and files rather than restarting from zero. This is why workers commit and push per finding: you can read progress from the git head instead of guessing, and a kill costs at most one in-flight change. Don't kill a slow-but-alive agent; make progress observable instead so you don't have to guess.

Recovery only works if work is isolated: every agent that mutates files or runs tests does so in its own worktree, so a kill mid-mutation costs one branch instead of corrupting the shared tree everyone depends on.

## Breadth is capped by this

Don't fan out wider than you can health-check on the tick. More parallel agents than you can keep alive is exactly how stalls hide. Monitorability, not raw capacity, sets your fan-out ceiling.
