---
name: integrate-dont-bolt-on
description: Guidance for changing an existing system, whether fixing a bug or adding a feature. Use whenever integrating new information or a new requirement into existing code: bug fixes, feature implementation, and the spec or plan that precedes them. Repair the root cause and fit the change into the design as a whole, refactoring where needed, instead of accreting another condition or special case.
---

# Integrate, Don't Bolt On

The most expensive habit in maintaining a system is answering each bug or requirement with "what do I add" instead of "what is actually wrong, and how does this belong in the design." Add-only changes accrete: conditionals breed conditionals, special cases pile up, and each patch creates the edges that become the next bug. That is the loop that turns a handful of defects into fifty rounds of fixing.

## Diagnose the root before changing anything

When a bug arrives, find why it exists, not just where it fails. Is this a missing case, or a sign the current shape is wrong? Would three more bugs of the same kind come from the same root? Fix the cause. A change that silences this instance while leaving the cause just schedules the next instance.

## Reintegrate, don't accrete

Ask how the change belongs in the system as it should be, then make the system that way. Often the right move is to refactor the existing structure so the new behavior falls out of it naturally, rather than wrapping the old structure in one more condition. Prefer the change that removes the class of problem over the one that handles this single case.

## Watch the bolt-on smells

These mean you are patching, not integrating: a conditional chain that keeps growing; a function that gets longer with every fix; flags and special cases multiplying; the same area producing bug after bug. When you see them, stop and reconsider the shape instead of adding the next branch.

## Test the invariant, not the patch

Write the test against the behavior or invariant that must hold, not against the specific patch. A test pinned to an implementation detail locks the bolt-on in and fights the refactor; a test pinned to the contract lets you repair the design freely and still proves correctness. Red, green, then refactor: the refactor step is where integration actually happens, and it is not optional. This is the guard against TDD quietly rewarding the smallest patch that goes green.

## Size the change honestly and surface it

Sometimes the holistic fix is larger than the bug. Do not silently bolt on to stay small, and do not silently launch a sweeping refactor either. Name it: "the real cause is Y, so the clean fix refactors X," with the cost, and let it move up for a decision. The goal is a deliberate choice, not a reflex in either direction.

## In planning, design for integration

When planning a spec or feature, work out how it fits the system as a whole, including the refactor it may need to fit cleanly, and authorize that refactor in the plan so the implementer is not forced to bolt on. A plan that treats every feature as an isolated addition is how a codebase accretes into a tangle. Plan the reintegration, not just the addition.
