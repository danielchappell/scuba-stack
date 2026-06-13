---
name: subtract-before-you-add
description: Guidance to apply before adding a feature, option, abstraction, configuration flag, or dependency. Use whenever you're about to add something to a codebase or design. The best change is often a removal; check whether removing or unifying gets you there before you grow the surface.
---

# Subtract Before You Add

Every concept you add is permanent carrying cost: more to document, test, explain, and keep consistent forever. So before you add, spend a minute trying to get there by removing.

## Ask the subtraction questions first

- Can something that already exists do this with a small change, instead of a new thing alongside it?
- Are you adding an option where a sensible default would serve, pushing a decision onto every future caller?
- Is there a special case you could delete by generalizing the common path, rather than another branch to maintain?

If removing or unifying gets you the outcome, prefer it. A smaller system that does the job beats a larger one that does the job plus options nobody asked for.

## Resist speculative generality

Build for the need in front of you, not the three you imagine. Abstractions added "in case we need them" usually fit the real future badly and cost from day one. It is cheaper to generalize later from two concrete cases than to carry a wrong abstraction now.

## Default to demand-driven scope

Add the feature when something actually needs it, not because it would round out the design. The discipline is the same as guarding scope: the question is never only "is this good," it's "is this needed now, and what does it cost forever."
