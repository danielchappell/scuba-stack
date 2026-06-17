# Contributing

Scuba Stack is a platform-neutral prompt/orchestration bundle. The main quality bar is clear, precise prose plus safe target translation.

## Source Rules

- Put reusable behavior in neutral core files: `core/`, `skills/`, `agents/`, and `project-template/TEMPLATE.md`.
- Put platform mechanics in `targets/<target>/` or `install.sh`.
- Neutral agents use `tool_profile` and `model_profile`; concrete tools/models belong in target manifests.
- Neutral skills should say "target guidance file" instead of naming `CLAUDE.md` or `AGENTS.md`.
- Keep `core/pointer.md` short because it is always-on.

## Target Rules

- A target manifest must define install paths, agent format, model profile mappings, and tool profile mappings.
- A hook adapter must live under `targets/<target>/hooks/`, have standalone fixtures, and have a live runtime smoke test before the installer wires it.
- Policy-only hook support is acceptable for a new target until its adapter is proven.

## Checks

```bash
bash -n install.sh
node scripts/render-target.mjs claude /tmp/scuba-claude
node scripts/render-target.mjs codex /tmp/scuba-codex
bash hooks/test-scuba-guard.sh
```

If a change touches installer behavior, describe exactly which files it writes under each target home and confirm it remains manifest-driven and surgical.
