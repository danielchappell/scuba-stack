---
name: adversarial-review
description: Procedure for gating work with fresh, independent, lensed hunters until a CLEAN verdict, and for front-running an external automated reviewer by tuning your own hunters to the bug categories it actually finds. Use at every quality gate: spec, plan, and code or PR review. Make sure to use this whenever reviewing or QAing substantive work before it advances, scaling the depth to the stakes.
---

# Adversarial Review

A single quality pass misses things. The backbone of quality here is fresh, independent hunters with distinct lenses, looping until a CLEAN verdict. Complementary lenses repeatedly catch what any one pass, including an external reviewer, misses.

## The loop

1. Run hunters that are **fresh** (not the author, not carrying the build context), **independent** (separate agents), and **lensed** (each with a distinct angle).
2. Each hunter verifies against the **actual code** — pulling the diff with `git`, running the touched tests in its own worktree to *prove* a finding rather than reason it, and grounding a finding in real docs (platform, security, library behavior) via web when the lens needs it — cites `file:line`, and separates real findings from speculation. It never `checkout`/`clean`/`reset`s a shared tree.
3. **Force exhaustiveness with a coverage denominator, not an exhortation.** "Be thorough" doesn't survive contact — a hunter finds a few salient hits, feels done, and you pay for the rest as extra rounds. So hand each hunter the explicit surface it must account for (the diff's files, the pattern's call sites, the spec's requirements), require it to walk every item and prove dryness with a second sweep, and make it return a **coverage line** (what it enumerated and walked) alongside its complete classified list with the shared root. Reject a findings list that arrives with no coverage line: a list with no denominator is an early-stop in disguise, and accepting it is what creates the review→fix→review churn.
4. Classify every finding REAL / DEFERRED / INVALID against the code. Don't blind-trust any hunter, internal or external; some findings are stale or wrong.
5. Revise, then re-review. Loop until a confirming pass returns zero real findings. That is CLEAN. A re-trigger is an open loop until that pass comes back, so track it.

## Lenses by gate

Pick complementary lenses for the artifact. As a starting set:

- **Spec** — isolation/security; correctness/conformance; model-soundness.
- **Plan** — spec-fidelity and test discipline; security and TOCTOU; conformance and dependencies.
- **Code / PR** — line-by-line over the diff including the fixer's own newly added code; security; deployment and network exposure (public vs private surfaces, open ports, secrets, infra/config); conformance to the approved spec and plan; and whether the change is a holistic repair or a bolt-on. Flag patch-accretion as a defect: a fix that adds a condition while leaving the root cause, a growing conditional chain, a function lengthening with each fix, or the same area generating repeat bugs. A change that works but accretes is a finding, not a pass.

## Front-run an external reviewer

If an external automated reviewer is in the loop, run your own hunters at its grade rather than waiting on its latency. When your hunters go dry but the external one keeps finding real bugs, read the categories of the bugs it actually validated, and add those categories as explicit named lenses. Maintain a living lens-list seeded from those hits. This converts your hunters from a substitute into a front-runner that catches the bug *class* before the external pass does, instead of re-running the same taxonomy and going dry while real bugs remain. A behavioral "dry" result still needs the external confirmation.

At the PR gate, don't serialize against it: open the PR to start the external reviewer, run your own swarm over the diff in parallel (about five lenses for a substantive PR, scaled to stakes), and reconcile both streams into one deduped, classified worklist before fixing. The `ship-gate` skill is that full sequence.

## Non-vacuous fixes

When a finding is fixed, prove the fix: write the test, see it RED, apply the fix, see it GREEN, then revert the fix and confirm it goes RED again before restoring. A test that passes without the fix proves nothing. Pin the test to the behavior or invariant that must hold, not to the specific patch, so the test survives a holistic refactor instead of locking a bolt-on in. Red, green, then refactor; the refactor step is where the change is integrated, and it is not optional.

## Receiving a finding

A finding handed to you — a hunter's report, a review comment, an external reviewer's prescribed patch — is a **hypothesis, not an order**. This is the posture every receiver of a finding holds, named once here and reached for by name. Before you implement it:

- **Verify it's real.** Classify it REAL / DEFERRED / INVALID against the actual code first. Some findings are stale, wrong, or already handled; don't act on a finding you haven't confirmed against the head.
- **Own the fix direction.** Re-derive the fix at the root yourself (per `integrate-dont-bolt-on`); take any prescribed patch as a lead to test, not a conclusion to install. Verify the *direction* against the invariant before applying — pinning the test to the invariant (not to the prescribed patch) is precisely what catches a wrong-direction prescription: a fix that fails open passes against its own patch but goes RED against the invariant that must hold.
- **Push back with evidence, don't perform agreement.** When a finding is wrong or its prescribed direction would regress the invariant, say so and show why. Silent compliance with a bad prescription is a defect, not deference.

## Scale to the stakes

This full machinery is for risky work: anything touching isolation, security, contracts, or data. A one-line config fix does not earn three adversarial hunters. Match the number and depth of lenses to the blast radius; over-gating low-risk work stalls the forward motion that matters as surely as under-reviewing risky work breaks it.

## Keep tooling out of here

How you query, resolve, or re-trigger a specific external reviewer is project mechanics and belongs in the project's {{target.rootGuidanceFile}}, not in this procedure.
