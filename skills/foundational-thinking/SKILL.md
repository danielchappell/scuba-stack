---
name: foundational-thinking
description: Guidance to apply before solving a problem: get the foundation right first. Use at the start of any non-trivial task, before designing or coding. Name what is actually being asked, the real constraints, the invariants, and the failure modes, so you don't build correctly on a wrong base.
---

# Foundational Thinking

Most expensive mistakes are not bad code; they are good code built on an unexamined assumption. Spend the first effort on the foundation, because everything downstream inherits it.

## State the real problem

Write, in a sentence, what is actually being asked, separate from the solution someone proposed. The proposed solution is often a guess at the problem; solve the problem, not the guess.

## Name the constraints and invariants

List what must always be true and what genuinely constrains the space (real limits, not inherited habits). These are the things a correct design has to respect; making them explicit is how you stop violating one by accident three layers in.

## Find the failure modes early

Ask what breaks this and what the worst input is, before you build the happy path. Designing with the failure cases in view produces a different, sturdier shape than bolting them on afterward.

## Don't build on an assumption you haven't checked

When a plan rests on "I assume X," verify X or mark it as the risk. The cheapest place to catch a wrong foundation is before you have built on top of it.
