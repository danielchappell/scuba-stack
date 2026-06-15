---
name: test-driven-development
description: Guidance for writing the test before the code. Use when building new behavior or fixing a bug — write the failing test first, watch it fail for the right reason, then make it pass. Test-first is a mandate with a few stated exceptions, not loose advice; reach for it before you write the implementation, not after.
---

# Test-Driven Development

Tests written after the code mostly prove the code does what it already does — they ossify the implementation instead of pinning the behavior, and the cases you'd have found by specifying the test first are the cases you now silently skip. Write the test first so the requirement, not the code, is what you're checking against.

## The mandate

For anything with real behavior, write the failing test before the implementation. This is required, not encouraged, for: any new behavior; any bug fix; any contract or boundary change; and anything touching isolation, security, money, or data. If you cannot state the test, you cannot yet state the behavior — that is the signal to stop and get clear, not to start typing the implementation.

## The stated exceptions

Test-first is **not** required for:

- **Exploratory spikes and throwaway prototypes** — you don't yet know the interface; the test comes once the shape is real and the spike is rebuilt as kept work.
- **Pure-config and Markdown/docs changes** — there is no behavior to assert.
- **Pure mechanical refactors already covered by existing tests** — the existing suite *is* the RED/GREEN guard; keep it green through the move.
- **Generated or vendored code** — you own its integration, not its internals.

Everything outside these exceptions is mandated. When in doubt about whether a change "has real behavior," it does — write the test.

## The machinery lives in adversarial-review

The RED → GREEN discipline — see it fail for the right reason, make it pass, then prove the fix is non-vacuous by reverting it and watching it go RED again — is owned by `adversarial-review`. Don't restate it; reach for it. A test that passes without the implementation proves nothing.

## Test the behavior, not the code

Per `integrate-dont-bolt-on`: pin the test to the invariant or contract that must hold, not to the specific lines you're about to write. A test bound to the implementation locks today's shape in and fights tomorrow's refactor; a test bound to the behavior survives the refactor and still proves correctness. Red, green, then refactor — the refactor step is where the change is integrated, and it is not optional.
