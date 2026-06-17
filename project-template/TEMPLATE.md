# <Project> — Project Context

Project-specific only. The Scuba Stack rules live globally after installation; do not repeat them here.

## Stack & conventions
-

## Paths & commands
- build:
- test:
- lint:

## External PR reviewer (used by `ship-gate`)
How this repo opens a PR and works with its external automated reviewer. Fill in for your setup; `ship-gate` supplies the ritual, this supplies the commands.
- Open the PR (starts the external reviewer): `gh pr create --fill --base <base> --head <branch>` — `<base>` is the **integration branch** for a story PR, `main` for the integration→main PR.
- Where the reviewer posts: <e.g. PR review comments, or a check named "...">
- Read its findings: `gh pr view <num> --comments` (or `gh api repos/<owner>/<repo>/pulls/<num>/comments`)
- Re-trigger after a fix: <e.g. push new commits, or reviewer-specific review command/comment>
- Typical latency: <so the internal swarm and reconcile are timed against it>
- **Reviews non-`main`-base PRs too?** The integration-branch model puts story PRs on a non-default base. Confirm your reviewer comments on those and do **not** restrict it to the default branch, or story PRs ship unreviewed.
- **Closeout verifies LIVE (the `ship-gate` DoD wiring).** `ship-gate` requires the closeout to re-verify against the current head, never from a prior report's numbers. The mechanics:
  - **Paginate review threads to exhaustion.** A page that returns exactly the page size is an early-stop in disguise. Drive the review-thread connection by `hasNextPage` or cross-check returned nodes against total count.
  - **Read mergeability per PR, not from a list endpoint.** List endpoints can return cache-miss/null mergeability. Query the single PR and poll until the state is known.
  - **Pin "clean" to the current head SHA.** Capture the head before verifying and treat the CLEAN verdict as bound to that SHA; if the head moved during verification, re-verify.

## Integration branches & merge policy
The manager grooms an epic into slices, each a story PR onto a shared **integration branch**; the assembled integration branch then goes to `main`. To let stories merge without blocking on you while keeping `main` yours alone:
- Pre-approve agent PR merges for integration-branch bases **only** (story → integration). Never pre-approve merges to `main`.
- The integration→`main` PR is opened for you and **you merge it** after its full `ship-gate` cycle.

## Project invariants
-
