---
name: systematic-debugging
description: Method for finding the cause of a bug, failing test, regression, or unexplained symptom whose cause is unknown. Use when something is broken and you don't yet know why — reproduce it, narrow by halving, instrument and read live state, and repair the root rather than silencing the symptom. Not for plan-writing or building features to a known design — but a senior-implementer whose own fresh build breaks reaches for this; it is the discipline for the unknown.
---

# Systematic Debugging

A bug is a question about how the system actually behaves; answer it with evidence before you touch a line. Guessing produces a fix that silences this instance and schedules the next. Get the foundation right first per `foundational-thinking`: name the real failure and the invariant it violates, not the first patch that comes to mind.

## Reproduce before you theorize

Reproduce the failure yourself, on the surface that actually exhibits it. If it resists, make it fail on purpose: construct the trigger, narrow the conditions, or add instrumentation until the failure shows itself. You cannot verify a fix for a failure you were never able to produce.

## Narrow by halving

List the plausible causes, then knock them down one at a time against what the running code actually shows, halving the search space each step until a single mechanism is left standing. When program state is opaque, add instrumentation and read it live — never reason from a guess. Confirm that surviving mechanism with evidence before you change anything.

## Find the root, not the symptom

- **Resist the guard.** A nil-check that silences a crash, a try/catch that swallows the real error — that is a symptom fix; the cause is still there, waiting.
- **Fix the class, not the instance.** Grep for the same shape elsewhere and repair all of it, per `integrate-dont-bolt-on`. One change that removes the category beats N patches that each breed the next.
- **State before code on restart bugs.** When something only breaks after a restart or redeploy, look at state, not logic: the source is identical between runs, but config, caches, lock files, and persisted data are not. A failure that vanishes when you wipe a state file is asking you to validate that state.

## Test the invariant, not the patch

Pin the regression test to the behavior that must hold, not to your specific patch, so it survives the refactor instead of locking a bolt-on in. Prove the fix is non-vacuous — RED before, GREEN after, RED again on revert — per `adversarial-review`. A green unit test proves a branch runs; it does not prove the bug is gone, so verify on the same surface you reproduced it on.
