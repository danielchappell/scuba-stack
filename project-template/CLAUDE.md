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
- Open the PR (starts the external reviewer): `gh pr create --fill --base <base> --head <branch>` — `<base>` is the **integration branch** for a story PR, `main` for the integration→main PR.
- Where the reviewer posts: <e.g. PR review comments, or a check named "...">
- Read its findings: `gh pr view <num> --comments` (or `gh api repos/<owner>/<repo>/pulls/<num>/comments`)
- Re-trigger after a fix: <e.g. push new commits, or comment "@codex review" on the PR>
- Typical latency: <so the internal swarm and reconcile are timed against it>
- **Reviews non-`main`-base PRs too?** The integration-branch model puts story PRs on a non-default base. Confirm your reviewer comments on those (Codex does by default) and do **not** restrict it to the default branch, or story PRs ship unreviewed.
- **Closeout verifies LIVE (the `ship-gate` DoD wiring).** `ship-gate` requires the closeout to re-verify against the current head, never from a prior report's numbers. The mechanics:
  - **Paginate review threads to exhaustion.** A `first:100` that returns exactly 100 nodes is an early-stop in disguise. Drive the GraphQL `reviewThreads` connection by `pageInfo.hasNextPage` (cursor through `endCursor` until false), or cross-check the returned `nodes` count against `totalCount` — never assume a single page is the whole set:
    ```
    gh api graphql -f query='query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){totalCount pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated}}}}}' -F o=<owner> -F r=<repo> -F n=<num> -F c=<cursor>
    ```
  - **Read `mergeable` per-PR, not from the list endpoint.** The list endpoint (`gh pr list --json mergeable` / `pullRequests` in GraphQL) returns a `null` cache-miss that reads as "no conflicts." Query the single PR so GitHub computes it: `gh pr view <num> --json mergeable,mergeStateStatus` (poll until `mergeable` is `MERGEABLE`/`CONFLICTING`, not `UNKNOWN`).
  - **Pin "clean" to the current head SHA.** Capture the head before verifying (`gh pr view <num> --json headRefOid -q .headRefOid`) and treat the CLEAN verdict as bound to that SHA; if the head moved during verification, the verdict is stale — re-verify against the new head.

## Integration branches & merge policy
The manager grooms an epic into slices, each a story PR onto a shared **integration branch**; the assembled integration branch then goes to `main`. To let stories merge without blocking on you while keeping `main` yours alone:
- Pre-approve agent `gh pr merge` for integration-branch bases **only** (story → integration). Never pre-approve merges to `main`.
- The integration→`main` PR is opened for you and **you merge it** after its full `ship-gate` cycle.

## Project invariants
-
