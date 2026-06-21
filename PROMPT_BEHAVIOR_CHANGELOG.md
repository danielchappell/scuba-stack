# Prompt Behavior Changelog

This file records intentional changes to rendered Scuba prompt behavior after
the Claude behavior baseline:

- Baseline commit: `3926827c74ab4adba42abfa715d130dd69860df9`

## 2026-06-21 PR Hardening Rounds

Intentional changes:

- Treat any external code-review comment round with at least one REAL finding
  as proof that the PR is not yet hardened, requiring a named hardening round
  pinned to the current head SHA.
- Require exactly two fresh adversarial reviewers for that round: one focused
  on the bug class or violated invariant implied by the comments, and one on
  adjacent edge cases, regressions, and integration fallout.
- Require the steward to reconcile external comments and both hunter reports
  into one deduped worklist, and the bug-fixer to repair the batch as one
  holistic system fix rather than comment-by-comment conditionals.
- Make one cohesive fix commit and one push the default output for a hardening
  round, with splits treated as explicit exceptions.

Non-goals:

- No watcher, polling, webhook, or target wake mechanics are introduced here;
  this only encodes the behavior once a comment round is known.

## 2026-06-21 Intake Challenge Floor

Intentional changes:

- Require substantive intake to include a compact challenge packet after a
  draft is on the table, so it cannot silently dispatch after zero user
  confirmation.
- Require the intake drafter to emit a non-empty `Challenge packet` section
  for substantive asks, phrased as confirmation when the inferred answers are
  obvious.

Non-goals:

- No return to cold survey intake; the flow stays draft-first, high-yield, and
  non-survey.
- No change to the lifecycle order, dispatch ownership, or target rendering
  format.

## 2026-06-17 Lifecycle Hardening

Intentional changes:

- Add dedicated `spec-reviewer`, `plan-reviewer`, and `acceptance-verifier`
  gates instead of using generic hunters for every non-code artifact.
- Make the lifecycle order explicit and executable from intake through
  spec approval, grooming, plan approval, build, acceptance verification, and
  ship gate.
- Add review profiles (`light`, `standard`, `high-risk`) with standard and
  high-risk hunter lens sets.
- Add roadmap event vocabulary so lifecycle transitions have named state
  updates.
- Add a Codex-native hook adapter and installer path with an explicit
  installed/pending-trust/operational status distinction.

Non-goals:

- No unrelated change to Claude install locations, target rendering format,
  or the existing Claude hook adapter.
- No change to the platform-agnostic source model: target-specific model,
  tool, hook, and guidance choices stay in target manifests and installers.
