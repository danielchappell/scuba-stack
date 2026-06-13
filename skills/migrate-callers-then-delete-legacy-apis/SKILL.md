---
name: migrate-callers-then-delete-legacy-apis
description: Guidance for replacing an API, function, or interface without leaving the old one behind. Use when introducing a new version of something that already has callers, deprecating a path, or changing a shared signature. The aim is to finish the migration in the same effort, not to leave two ways to do one thing.
---

# Migrate Callers, Then Delete Legacy APIs

A replacement that leaves the old path alive doesn't reduce complexity, it doubles it. Two ways to do one thing means two things to maintain, two things to test, and a slow drift as new code splits between them. Finish the move.

## Expand, migrate, contract

Add the new API alongside the old (expand). Move every caller to it, one verifiable step at a time (migrate). Then remove the old one (contract). The migration isn't done when the new thing exists; it's done when the old thing is gone.

## Prove there are no callers before you delete

Before removing the legacy path, verify it has zero remaining references, by search across the codebase, not by memory or assumption. A "deprecated" comment is not removal; it's a reminder you deferred the work and the debt is still on the books.

## Keep each step shippable

Each migration step should leave the system working, so the change can land incrementally and a problem is easy to localize. A big-bang swap of every caller at once is harder to review and riskier to revert than a sequence of small, verified moves.

## Don't leave a compatibility shim as a permanent resident

A temporary adapter is fine as scaffolding during the migration. Give it an end date and delete it with the legacy path. Shims that outlive their migration become exactly the dual-maintenance burden you were trying to avoid.
