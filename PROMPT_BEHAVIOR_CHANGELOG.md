# Prompt Behavior Changelog

This file records intentional changes to rendered Scuba prompt behavior after
the Claude behavior baseline:

- Baseline commit: `3926827c74ab4adba42abfa715d130dd69860df9`

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
