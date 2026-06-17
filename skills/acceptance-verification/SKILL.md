---
name: acceptance-verification
description: Independent verification gate for built work against the approved spec, approved plan, and definition of done. Use before opening a PR and again after PR-fix diffs before declaring clean or mergeable. The verifier runs relevant checks where possible, verifies no drift, and returns CLEAN or findings with current-head evidence.
---

# Acceptance Verification

This is the independent build-verification gate. It checks the built diff
against the approved spec, approved plan, and definition of done. It is not PR
hunting and it is not implementation.

## Contract

The acceptance-verifier is fresh and independent from the builder and fixer. It
reads the approved spec, approved plan, definition of done, current diff, and
relevant code. It runs the smallest sufficient set of commands to prove the
acceptance criteria where the environment allows it. It does not edit code,
rewrite tests, or fix findings.

Run this gate:

- before a PR is opened for a slice or integration branch;
- after any PR-fix diff that changes behavior before the steward declares the
  PR clean or mergeable.

Pre-PR findings route to the senior-implementer for the slice. Post-PR-fix
findings route through the steward, normally to the bug-fixer for root-cause
repair. The gate is closed only when a fresh verification of the current head
returns CLEAN.

## Coverage

Use a coverage denominator. Enumerate what you verified:

- every acceptance criterion in the approved plan;
- every relevant requirement and non-goal in the approved spec;
- the current head SHA and changed files reviewed;
- commands run, commands skipped, and why any command could not run;
- edge cases, failure modes, and security/isolation or data/contract concerns
  the plan said to carry forward;
- drift from the approved artifacts, even when the code works.

A verification with no current head SHA and no coverage line is not valid.

## Findings

Each finding must say:

- the failing acceptance criterion, spec requirement, or drift point;
- evidence from the current diff, code, command output, or skipped-command
  constraint;
- severity and whether it blocks PR creation or merge;
- the likely owner of the repair.

Do not suggest cosmetic improvements. Acceptance verification is about whether
the built artifact satisfies the approved contract.

## Output

Return this shape:

```text
Coverage: <items enumerated and walked>
Verdict: CLEAN | FINDINGS
Current head: <sha>
Commands run:
- <command> -> <result>
Commands not run:
- <command> -> <reason>
Findings:
- <severity> <criterion/evidence> <required correction> <owner>
Drift:
- <approved artifact section> -> <observed drift>
```

If the verdict is CLEAN, the findings and drift lists are empty and the artifact
is ready for the next gate. Do not spawn other agents.
