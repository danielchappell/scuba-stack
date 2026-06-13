---
name: boundary-discipline
description: Guidance for deciding where code lives and what a module, package, or service exposes. Use when placing new code, designing an interface between parts, splitting or merging modules, or answering ownership and layering questions. A boundary is a promise; keep them few, explicit, and stable.
---

# Boundary Discipline

Every boundary you draw is a promise to everyone on the other side of it. Promises are expensive to change, so draw few of them, make them explicit, and keep their insides hidden.

## Expose intent, hide internals

A module should present the smallest surface that serves its consumers, and nothing more. The shape of the data it stores, the library it uses, the order it does things in, are its own business. A boundary that leaks its internals is not a boundary; it is a habit waiting to become a dependency.

## Depend on contracts, not implementations

Consumers should bind to an interface or a shared contract type, not to the concrete thing behind it. Put the types that cross a boundary in a contracts layer both sides import, so neither side reaches into the other's guts. When you can swap what is behind the boundary without touching callers, the boundary is real.

## Cut along the seams that actually exist

The right boundary separates things that change for different reasons and keeps together things that change together. A split that forces every feature to edit three packages is the wrong split; a merge that couples two things with unrelated lifecycles is the wrong merge. If a change keeps crossing a boundary, the boundary is in the wrong place.

## Name the owner

For any concept, one unit owns it; the rest reference it. Ambiguous ownership is where duplication and drift breed. Before adding code, answer plainly: which unit owns this, and am I reaching across a boundary to do it.
