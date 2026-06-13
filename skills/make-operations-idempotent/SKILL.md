---
name: make-operations-idempotent
description: Guidance for designing operations that are safe to run more than once with the same effect. Use when designing writes, webhooks, job handlers, migrations, payment or messaging flows, or anything that can be retried or delivered more than once. The goal is that a duplicate call changes nothing beyond the first.
---

# Make Operations Idempotent

Anything that can be retried will be retried, and anything delivered at-least-once will sometimes arrive twice. Design so a repeat is a no-op, and a whole category of double-charge, double-send, and duplicate-row bugs disappears.

## Set state, don't nudge it

Prefer operations that set a value to a known result over ones that adjust it relative to the current value. "Set status to paid" survives a replay; "increment balance" does not. Where you must accumulate, gate it behind a dedupe key so the same event counts once.

## Carry an idempotency key

For externally triggered writes (webhooks, client submissions, jobs), require a stable key the caller provides or you derive from the payload. Record processed keys and short-circuit a repeat. The key is what lets a retry be safe instead of a second effect.

## Make check-then-act atomic

"Read, see it's absent, then insert" is a race two retries will lose. Use an atomic conditional write, a unique constraint, or an upsert so the database, not your timing, enforces once-only.

## Be tolerant on the receiving end

A handler should assume duplicate delivery and reconcile to the intended end state rather than erroring or re-doing. Idempotency is a property of the whole path, not just the happy first call.
