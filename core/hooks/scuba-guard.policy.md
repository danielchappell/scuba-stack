# Scuba Guard Policy

This is the target-neutral policy for Scuba Stack's enforcement hook. Hook runtimes are not portable: each target owns its event names, input JSON, output/deny contract, trust model, and worktree layout. Keep those mechanics in target adapters.

The policy has two required checks where the target can enforce them mechanically:

1. **Worktree containment**
   - Code-writing workers may write product code only inside their own worktree.
   - Writes to any path with an exact `.scuba` path component are allowed because orchestration artifacts live in the shared control plane.
   - Writes to system temp directories are allowed for scratch work.
   - The lead session may write docs/operator files and `.scuba` files, but should be denied from editing tracked product code when the target can distinguish that case reliably.

2. **Never-draft PRs**
   - Block commands that create draft PRs, because draft PRs do not trigger the external reviewer flow Scuba front-runs.
   - At minimum, block the target's common CLI form for draft creation.

Adapter requirements:

- Fail open for infrastructure problems that would otherwise brick every tool call.
- Fail loud for policy denies: include the resolved path or command and the violated rule in the message returned to the agent.
- Keep hook configuration surgical and idempotent in the target installer.
- Ship a standalone fixture runner for every target adapter.
