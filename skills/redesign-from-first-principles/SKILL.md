---
name: redesign-from-first-principles
description: Guidance for when a design keeps fighting you. Use when patches are accumulating, every change touches many places, or the current shape feels wrong. Re-derive the design from the actual requirements and constraints, ignoring the current structure, instead of patching the local optimum.
---

# Redesign From First Principles

Patching a design that is fighting you buys a little time and adds a little debt, every time, until the structure is the problem. When you notice that, stop patching and re-derive.

## Derive from requirements, not from the current shape

Set the existing structure aside and ask what you would build today, knowing what you now know, to meet the actual requirements. The current shape carries the marks of constraints that may no longer apply; don't let it anchor the answer.

## Separate essential constraints from inherited accidents

Some constraints are real (the domain, the data, hard external limits). Some are just how it happens to be built. A first-principles redesign keeps the first and is free to discard the second. Tell them apart explicitly.

## Use it deliberately, not reflexively

This is the expensive move. Reach for it when the local-optimum patching has clearly stopped paying, not for routine changes. The signal is structural: the same kind of change keeps being hard in the same way.

## Cost the migration honestly

A cleaner target design still has to be reached from where you are. Pair the redesign with a believable, incremental path to it, or it stays a nicer idea you never ship.
