---
name: sequence-verifiable-units
description: Guidance for sizing work before you build it. Use when a change is bigger than one reviewable PR, or when planning an epic. Cut it into small, independently-shippable slices that each prove themselves and ship one at a time, rather than batching an epic into one long-lived PR that never converges.
---

# Sequence Verifiable Units

The unit of work is the smallest change that ships on its own and proves it works — not the epic. A large change shipped as one PR does not converge: every fix-push adds code, which draws another review round, which finds new problems in the new code, indefinitely. The review tail grows with the diff, so the diff is the lever.

## Cut into slices, ship one at a time

- **Independently shippable.** Each slice ships on its own and leaves the system working. Prefer a thin vertical slice — one real capability, end to end — over a horizontal layer that's inert until the next ten land.
- **Independently verifiable.** Each slice carries the test that proves it: the failing test lands before the change, green after. A slice with no way to prove it is too vague to ship.
- **Small enough to go quiet.** Size each to a PR a reviewer finishes in one pass. If it would draw round after round of review, it's still too big — cut again.
- **Sequenced by real dependency only.** Order slices so each builds on merged work; name the genuine dependencies, and don't invent ones — independent slices ship in parallel.

## Why it's load-bearing

A 30-task epic on one branch diverges from main, accumulates an endless review tail, and lets no one tell "another bug fixed" from "closer to mergeable." Ten small PRs each go quiet and merge. Slicing is how a big change actually finishes — turning the epic into shippable stories is the `groomer`'s whole job, and it's what keeps the review loop from running forever.
