---
name: type-system-discipline
description: Guidance for designing types, APIs, and data models in a typed language so the compiler carries the invariants. Use when defining types, designing an interface or data model, or deciding how to represent state, especially in TypeScript. The aim is to make illegal states unrepresentable so whole classes of bug never compile.
---

# Type System Discipline

A type is a proof obligation you hand to the compiler instead of to a reviewer at 2am. Spend types generously up front and you buy back runtime checks, defensive code, and review effort later.

## Make illegal states unrepresentable

Model the domain so the bad cases cannot be constructed. A value that is "either loading, or loaded with data, or errored" is a discriminated union, not an object with three optional fields and an implicit rule about which combination is valid. If the type permits a nonsense combination, someone will eventually build it.

## Parse, don't validate

Turn unknown input into a precise typed value once, at the boundary, and trust it everywhere inside. A function that re-checks whether its argument is valid is a sign the type upstream was too loose. Validate at the edge, carry certainty through the core.

## Avoid stringly-typed and primitive-obsessed code

An id is not a `string`; a currency amount is not a `number`. Use branded or nominal types so a user id can't be passed where an order id is expected. Replace open string parameters with unions of the actual allowed values, so the compiler rejects a typo instead of production.

## Keep the escape hatches shut

`any`, unchecked casts, and non-null assertions silently delete the guarantees you paid for, and they spread. Reach for `unknown` and narrow, not `any`. When you must cast, isolate it behind a parsed boundary and comment why.

## Let exhaustiveness do the work

Prefer switches and matches the compiler checks for completeness, so adding a new case forces every handler to acknowledge it. The goal throughout: when a class of bug becomes a compile error, you stop spending attention on it.
