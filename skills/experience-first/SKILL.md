---
name: experience-first
description: Guidance for designing from the outside in. Use when designing a feature, an API, a CLI, or any interface. Start from the experience of whoever will use the thing, the user, the caller, the operator, and work back to the implementation, not the other way around.
---

# Experience First

Design that starts from the implementation produces things that are convenient to build and awkward to use. Start from the experience you want on the other side, and let that pull the implementation into shape.

## Write the desired use first

Before building, write the call site, the command, or the screen flow as you wish it existed. The ergonomics you want at the point of use are the requirements; the implementation's job is to deliver them, not to dictate them.

## Pick the right "who"

For a product feature, design from the user's experience. For an API, from the caller's ergonomics. For a tool or service, from the operator's. Name whose experience leads, and make their common path the easy one.

## Make the right thing the easy thing

The default should be the correct, safe, common case; the unusual case can cost more. If the easy path is the wrong one, people will take it anyway and you'll own the consequences.

## Let needs, not a vendor's shape, define the interface

When wrapping something external, shape the interface around what your side actually needs, not around the vendor's API. Genericize from your own use, so the abstraction fits the experience you're building, not the tool you happened to pick.
