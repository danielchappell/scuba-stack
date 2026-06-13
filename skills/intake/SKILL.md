---
name: intake
description: The chief of staff's ritual for turning the user's raw, underspecified ask into a dispatchable mandate before any work is dispatched. Use at the very front, whenever a new ask arrives or an ambiguity escalates back up, and before delegating anything substantive. Delegate the drafting to an intake-drafter so the chief of staff stays free; own the conversation, grill the user against the draft's assumptions and forks, and loop until the mandate is solid. Make sure to use this before dispatching substantive work, so the spec is built on extracted intent rather than a guess.
---

# Intake

The whole lifecycle starts here, and it's the one gap the rest of the machinery can't cover: spec, plan, build, and review all validate work *against a mandate*, none of them check that the mandate matches what was in the user's head. The only source of that truth is the user, and you are the only agent holding their channel. So drawing the real mandate out of the user is your job, and it is not optional before substantive work.

Do not grill the user cold. People are poor at producing requirements in a vacuum and sharp at reacting to a concrete draft, and the wrong-thing risk lives in the assumptions a draft makes silently. So work draft-first: get a draft on the table with its guesses made loud, then have the user react to it.

## Stay free; delegate the drafting

You own the conversation, not the drafting. Hand the user's ask and pointers to context (the repo, this repo's `CLAUDE.md`, the control plane) to an `intake-drafter` agent, which reads the context and writes a structured draft mandate (goal, assumptions, definition of done, forks with chosen defaults, scope and non-goals, open questions) to the control plane. It does the context-heavy work in its own window; you relay and present. This is the same split as the executive brief, where you present but the specialist renders. Your turn stays thin, so your context stays free for everything else in flight.

## Scale the drafting to the stakes

- **Trivial or already-clear ask** — draft the one-line mandate inline yourself and skip the drafter. Don't summon machinery for a config tweak.
- **Substantial ask** — delegate to a single `intake-drafter`.
- **Genuinely ambiguous or high-stakes ask** — spawn two or three competing drafters with different readings of the goal, and present the framings together so the user picks or grafts in one pass. This is arena applied to intake; reserve it for real ambiguity.

## Grill in high-yield rounds

Present the draft to the user with every assumption and every fork surfaced at once. One rich round the user reacts to beats a dribble of single questions. Bring the forks as real choices with your recommended default, the way you surface any decision. Take their corrections back to the drafter to fold in at the root, and re-present only what changed.

The human channel is the real bottleneck, not your context. Drafters parallelize; conversations with the user do not, because there is one of them. Run as many drafters as are useful, but expect to talk the user through one intake at a time, and make each round earn its interruption.

## Know when to stop

Stop when the mandate is dispatchable: goal, constraints, definition of done, scope, and quality bar are settled enough to hand down, and the only residue is open questions that are genuinely the spec's to resolve. Don't interrogate past that point; over-grilling stalls forward motion as surely as dispatching a guess breaks it. Log the residual open questions in the mandate so the downstream spec carries them rather than losing them.

## Hand off

The finished mandate, on the control plane, is what seeds the work: a manager turns it into a spec for a big chunk, or a direct specialist takes it as the task for a one-level dispatch. Either way, write it to the control plane before you dispatch, per `chief-of-staff`.
