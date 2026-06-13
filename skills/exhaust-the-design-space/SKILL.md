---
name: exhaust-the-design-space
description: Guidance to apply before committing to a design. Use when choosing an approach for any non-trivial piece of work. Generate two or three genuinely different options and name their tradeoffs before picking, rather than building the first workable idea.
---

# Exhaust the Design Space

The first workable idea is rarely the best one; it is just the first. A few minutes spreading the options costs almost nothing against the price of building the wrong shape and living with it.

## Generate real alternatives

Produce at least two or three approaches that are actually different, not the same design with cosmetic variation. If your alternatives all share the core assumption, you have not yet left the first idea.

## Name the tradeoffs explicitly

For each option, say what it is good at and what it costs: complexity, performance, flexibility, migration burden, blast radius. A choice you can't explain the tradeoffs of is a choice you haven't really made.

## Then commit, and say why

Pick one, and record the one-line reason and the main alternative you rejected. This is what lets a reviewer, or you in six months, understand the decision instead of relitigating it.

## Match the effort to the stakes

A reversible, low-blast-radius choice does not need three fleshed-out options; a hard-to-change one does. Spend the exploration where being wrong is expensive.
