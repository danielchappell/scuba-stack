---
name: separate-before-serializing-shared-state
description: Guidance for what to do before you serialize or share state across a boundary such as a process, service, cache, or the wire. Use when designing a payload, a cached value, a token, or any state two parts will both depend on. Shared serialized state is the most expensive coupling, so separate and minimize it first.
---

# Separate Before Serializing Shared State

The moment state crosses a boundary in serialized form, both sides are married to its shape, and changing it later means a coordinated migration. So before you commit to that, pull apart what truly must be shared from what doesn't.

## Don't serialize what you can recompute

Derived values do not belong in a shared payload; recompute them on the side that needs them. Every derived field you serialize is a value that can go stale and a field you now have to keep consistent across the boundary forever.

## Keep local state local

Mutable state that only one side actually needs should stay there, not be hoisted into the shared surface for convenience. The shared surface is the part that's hard to change; keep it as small as the problem allows.

## Make the boundary explicit and versioned

What does cross should have a named, deliberate shape with a version, so the two sides can evolve without a flag-day break. An implicit, unversioned shared structure is a coupling you'll discover only when you try to change it.

## Decide ownership of the shared part

For the state that genuinely must be shared, name which side owns its meaning and which only reads it. Shared state with two writers and no owner is where the hardest consistency bugs live.
