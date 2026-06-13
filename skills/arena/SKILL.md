---
name: arena
description: A play for genuinely uncertain design problems. Spawn several independent attempts at the same task in parallel, evaluate them against one bar, pick a base, and fold the best pieces of the others into it. Use only when the right shape is unclear and the cost of several parallel Opus attempts is justified, never for routine work. Run by a manager or the orchestrator, since it spawns workers.
---

# Arena

When the right design is genuinely unclear and getting it wrong is expensive, it can be worth racing a few independent attempts instead of betting on one. This is a play the manager or orchestrator runs, not a worker, because it spawns workers and a worker can't.

## When to reach for it

Use arena only when the shape is honestly uncertain and a wrong choice is costly to unwind: a load-bearing abstraction, a tricky algorithm, a design with no obvious frontrunner. For routine work with a clear approach, it's pure waste. It runs several Opus agents in parallel, so the uncertainty has to be real enough to justify the spend.

## How it runs

1. Give the same mandate to a small number of independent candidates (two or three), each in its own isolated worktree so they don't collide. Don't let them see each other's work; independence is the point.
2. Evaluate all candidates against one explicit bar (the definition of done plus the qualities you care about), ideally through a fresh reviewer so the judging is lensed and honest, not just a vibe.
3. Pick a base: the candidate with the soundest overall shape, not necessarily the most complete.
4. Fold the best pieces of the runners-up into that base. Take the single strongest idea from each rather than blending them into mush.

## Discipline

- Cap the candidate count; more than three rarely adds signal and multiplies cost.
- Judge against the bar, not by which is furthest along. A clean partial beats a complete tangle.
- Keep it gated. Arena is the exception you justify, not a default mode.
