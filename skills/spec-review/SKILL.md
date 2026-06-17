---
name: spec-review
description: Review gate for a proposed spec before the user is asked for spec go/no-go. Use after the architect produces a spec and before grooming, planning, or implementation. The reviewer checks the mandate, existing system, edge cases, security/isolation, risks, and testability, then returns CLEAN or findings with a coverage line.
---

# Spec Review

This is the review gate for a spec. It happens after the architect writes the
spec and before the manager grooms, plans, or dispatches build work.

## Contract

The spec-reviewer is fresh and independent from the architect. It reads the
mandate, the proposed spec, relevant code, and relevant control-plane files. It
does not edit code or rewrite the spec. It returns a verdict for the manager:
CLEAN, or findings that must be routed back to the architect.

The loop is closed only when a fresh review of the revised spec returns CLEAN.
Then, and only then, the manager asks the user for spec go/no-go.

## Coverage

Use a coverage denominator. Enumerate what you reviewed before judging it:

- mandate requirements and explicit non-goals;
- relevant existing code paths, APIs, data/contracts, and boundaries;
- user decisions and constraints recorded in the control plane;
- edge cases, failure modes, and security/isolation implications;
- testability and acceptance evidence the later plan can actually satisfy.

Walk every item. A review with no coverage line is not valid.

## Findings

Each finding must say:

- the spec section or requirement it concerns;
- the violated invariant, missing requirement, or unsupported assumption;
- severity and whether it blocks user approval;
- the evidence from the mandate, existing code, or relevant docs;
- the likely owner of the repair, normally the architect.

Spec findings are not implementation prescriptions. They are requirements or
design gaps the architect must resolve before the user is asked to approve the
spec.

## Output

Return this shape:

```text
Coverage: <items enumerated and walked>
Verdict: CLEAN | FINDINGS
Current artifact: <spec path or identifier reviewed>
Findings:
- <severity> <spec section/evidence> <required correction>
User decisions:
- <only decisions that cannot be made below the user>
Risks:
- <non-blocking risks to carry into plan review>
```

If the verdict is CLEAN, the findings list is empty and the review states that
the spec is ready for user go/no-go. Do not spawn other agents.
