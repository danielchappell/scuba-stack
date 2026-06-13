# <Project> — Project Context

Project-specific only. The Scuba Stack rules live globally at ~/.claude — do not repeat them here.

## Stack & conventions
-

## Paths & commands
- build:
- test:
- lint:

## External PR reviewer (used by `ship-gate`)
How this repo opens a PR and works with its external automated reviewer (e.g. Codex). Fill in for your setup; `ship-gate` supplies the ritual, this supplies the commands.
- Open the PR (starts the external reviewer): `gh pr create --fill --base main --head <branch>`
- Where the reviewer posts: <e.g. PR review comments, or a check named "...">
- Read its findings: `gh pr view <num> --comments` (or `gh api repos/<owner>/<repo>/pulls/<num>/comments`)
- Re-trigger after a fix: <e.g. push new commits, or comment "@codex review" on the PR>
- Typical latency: <so the internal swarm and reconcile are timed against it>

## Project invariants
-
