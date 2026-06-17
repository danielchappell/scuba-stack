---
name: plan-review
description: Review gate for an implementation plan before the user is asked for plan go/no-go. Use after grooming and plan drafting, before implementation. The reviewer checks fidelity to the approved spec, slice order, test discipline, failure modes, edge cases, and review profile selection, then returns CLEAN or findings with a coverage line.
---

# Plan Review

This is the review gate for an implementation plan. It happens after the spec is
approved and the work has been groomed into the right slice shape, and before
any slice is built.

## Contract

The plan-reviewer is fresh and independent from the planner and groomer. It
reads the approved spec, the groomed slice map, the proposed implementation
plan, relevant code, and control-plane decisions. It does not edit code or
rewrite the plan. It returns CLEAN, or findings that the manager routes to the
right owner.

Plan defects in implementation approach go back to the architect. Slice-shape or
dependency defects go back to the groomer. Product or direction questions go to
the user after the manager frames them.

The loop is closed only when a fresh review of the revised plan returns CLEAN.
Then, and only then, the manager asks the user for plan go/no-go.

## Coverage

Use a coverage denominator. Enumerate what you reviewed:

- every approved spec requirement and non-goal;
- every planned slice, dependency, branch target, and acceptance criterion;
- tests to be written or run, including red/green expectations;
- edge cases, failure modes, rollback/retry concerns, and concurrency or
  time-of-check/time-of-use risks where relevant;
- security/isolation, data/contracts, migrations, public API, and integration
  branch implications;
- the selected review profile and whether the risk triggers justify it.

Walk every item. A plan review with no coverage line is not valid.

## Findings

Each finding must say:

- the plan section, slice, test, or dependency it concerns;
- the approved spec requirement or invariant at risk;
- severity and whether it blocks user plan approval;
- the evidence from the spec, code, or control-plane decisions;
- the likely owner of the repair: architect, groomer, or user decision.

Do not prescribe a patch. The plan author owns the corrected plan.

## Output

Return this shape:

```text
Coverage: <items enumerated and walked>
Verdict: CLEAN | FINDINGS
Current artifact: <plan path or identifier reviewed>
Review profile: light | standard | high-risk
Findings:
- <severity> <plan/slice/evidence> <required correction> <owner>
User decisions:
- <only decisions that cannot be made below the user>
Carry-forward risks:
- <non-blocking risks acceptance-verifier or hunters must remember>
```

If the verdict is CLEAN, the findings list is empty and the plan is ready for
user go/no-go. Do not spawn other agents.
