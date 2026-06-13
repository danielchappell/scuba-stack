---
name: ship-gate
description: The ritual for taking completed, verified work up for review. Use the moment a build is done and ready to go up: when finishing a chunk, opening or putting up a PR, or shipping a change. Open the PR first to start the external reviewer, then in parallel run a swarm of fresh independent Opus reviewers over the diff, reconcile their findings with the external reviewer's into one classified list, fix the root causes in a single holistic pass, and loop until CLEAN. Make sure to use this whenever work is finished and about to go up for review, so you find your own bugs instead of waiting on the PR queue.
---

# Ship Gate

This is what "done" means for a chunk: not "the build runs," but "the build has survived a parallel adversarial swarm and the external reviewer, and every real finding is repaired at the root." You reach this gate only after the build is verified against the definition of done and the approved spec and plan. Drift from those is a defect even when the code runs; catch it here, not after merge.

The point of the gate is to stop waiting. The external reviewer runs on its own latency; your own reviewers run on yours. Run them at the same time so you are never idle, and so you catch the bug *class* before the external pass does (front-running, per `adversarial-review`).

## The sequence

1. **Open the PR first.** Putting it up starts the external reviewer's clock immediately, so it churns while you work. Do this before anything else at the gate. How the PR is opened and how the external reviewer is triggered are project mechanics; they live in the repo's `CLAUDE.md`.
2. **Launch the internal swarm in parallel.** Spawn a panel of fresh, independent `reviewer` agents, one lens each, over the diff, per `adversarial-review`. Default to about five for a substantive PR; scale down for a trivial change and up for anything touching isolation, security, contracts, or data. Reviewers are read-only and don't count against the build cap, so a swarm running alongside the work is safe. Each reads the actual diff line-by-line, including any code the fixer has already added, cites `file:line`, and labels findings REAL or SUSPECTED.
3. **Reconcile the two streams.** When the swarm returns and the external reviewer reports, merge both into one list. Dedupe: five reviewers and an external pass will report the same defect in different words. Classify each finding REAL / DEFERRED / INVALID against the actual code. Don't blind-trust either stream; some external findings are stale or wrong, some internal ones are speculation. The output is one deduped, classified worklist, not five reports and a robot's comments sitting side by side.
4. **Fix at the root, once.** Repair the REAL findings as a single integration pass, per `integrate-dont-bolt-on`, not as N separate patches. Overlapping symptoms from many reviewers usually trace to one root cause; fix the cause once and the symptoms fall together. Every fix is non-vacuous (test RED, fix, GREEN, then red-green-refactor) per `adversarial-review`. A swarm plus an external reviewer is exactly the situation that tempts a bolt-on per finding and produces the long bug-round tail; resist it here.
5. **Re-review to CLEAN.** Re-run the loop over the new diff, including the code you just added, until a confirming pass returns zero real findings. A re-trigger of either the swarm or the external reviewer is an open loop until it comes back; track it, and never read absence-of-notification as success (per `process-health-monitor`).

## Done

The gate is passed, and the chunk is reportable up, when the internal swarm is CLEAN, every real external finding is fixed or explicitly deferred with a stated reason, and the build still verifies against the spec, plan, and definition of done. Until then the work is in-flight, not done. The user is the only one who merges to main; the gate produces a PR ready for that decision, it does not merge.

## Scale to the stakes

Five reviewers and the full reconciliation are for substantive changes. A one-line config fix does not earn a swarm; put up the PR, let the external reviewer run, and a single lens is enough. Over-gating trivia stalls the forward motion as surely as under-gating risk breaks it.

## Keep tooling out

The commands to open the PR, read the external reviewer's findings, and re-trigger it are project mechanics and live in the repo's `CLAUDE.md`. This skill is the ritual; the repo supplies the wiring.
