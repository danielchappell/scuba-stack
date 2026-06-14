# Run-book — Operating Scuba Stack with Agent Teams

This is the operator's guide. The behavior lives in the skills and `CLAUDE.md`; this file is how you turn it on and drive it.

## One-time setup

Full install is in `INSTALL.md`; the short version:

1. **Run the installer.** From the unzipped bundle, `bash install.sh` installs the skills to `~/.claude/skills/`, the agents to `~/.claude/agents/`, and the pointer as `~/.claude/scuba.md` (imported by a single line in `~/.claude/CLAUDE.md`). User scope, so every project gets them. It's idempotent — re-run it anytime to update; it replaces only the org's files and leaves your other skills, agents, and personal `CLAUDE.md` content alone.
2. **Enable Agent Teams.** Add the flag to the `env` block of `~/.claude/settings.json`, then restart your terminal (needs Claude Code v2.1.32+):
   ```json
   { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
   ```
3. **Disable conflicting plugins.** If the `superpowers` plugin is enabled it makes this org's skills inert in workers — disable it before running. See the [conflicting-plugins step in `INSTALL.md`](INSTALL.md#conflicting-plugins-disable-superpowers).
4. **Nothing to create per repo.** The chief of staff initializes the `.scuba/` control plane (`roadmap.md`, `teams/`, `briefs/`) itself the first time you use the org in a repo. Optionally add project specifics (stack, paths, commands) to that repo's own `CLAUDE.md`.
5. **Pre-approve permissions.** Teammates inherit the lead's permission mode at spawn and their prompts bubble up to the lead, which creates friction in an always-running org. Pre-approve the common operations before spawning, and use the **default** permission mode, not delegate mode (delegate mode passes its restrictions to teammates and leaves them unable to work). For low-risk runs you can launch with `--dangerously-skip-permissions`, but only when you mean it.
6. **(Optional) Split-pane view.** Default in-process mode works in any terminal. For a pane per teammate, run inside tmux or iTerm2: `claude --teammate-mode tmux`. Split-pane isn't supported in the VS Code integrated terminal.

## Directory layout

```
~/.claude/              # user scope — installed once, shared by every project
  scuba.md              # the always-on pointer (imported by ~/.claude/CLAUDE.md)
  agents/               # worker pool: architect, groomer, hunter, bug-fixer, steward, senior-implementer,
                        #   researcher, intake-drafter, brief-specialist, scribe
  skills/               # chief-of-staff/, team-manager/, ship-gate/, adversarial-review/, …
  .scuba-manifest       # internal: what the installer placed, for clean reinstall

your-repo/              # per project — nothing required up front
  CLAUDE.md             # optional: project stack, paths, external-reviewer wiring
  .scuba/               # the control plane — gitignored, visible on your branch, shared by all agents
    roadmap.md          # resume anchor: the state-of-the-world tree
    teams/<team>/       # per-manager state: status, spec, plan, decisions
    briefs/             # rendered per-epic briefs (architecture brief at design-done, executive brief at merge)
```

## Running it

1. **Start the chief of staff** as your lead session: open Claude Code **on Opus** (the lead and its manager teammates run on the session model, so this is what pins your judgment layer to Opus), tell it it's your chief of staff and to read `CLAUDE.md`, and give it your ask. Only the worker subagents set their own model in their agent files; the lead and managers do not, so launching on Sonnet silently downgrades the whole judgment layer.
2. **It dispatches at the right depth.** For a contained task or research it spins up a single worker subagent directly. For an epic it runs the `team-manager` lifecycle itself — a hat the chief of staff wears, not a separate agent it spawns (a spawned teammate manager is the scaling path for when one session can't hold every epic at once). Every dispatch carries a full mandate (goal, constraints, deliverable, definition of done, paths, quality bar). Typical load is two to four tasks plus a researcher.
3. **It runs the epic's lifecycle in manager mode**, spawning the worker subagents, grooming into slices, running the review loop, owning the integration branch, monitoring, and keeping the roadmap current on its heartbeat.
4. **You stay talking to the chief of staff.** Hand it new asks, redirect, reprioritize. It stays free because it dispatches rather than triaging or building — if you ever see it grinding through a backlog itself, that's the bug.

## Watching and steering

- `Ctrl+T` — the shared task list across the team.
- `Shift+Up` / `Shift+Down` — move between teammates.
- `Enter` — view a teammate's session; `Escape` — interrupt.
- You can navigate straight to any manager and give it instructions directly, the same as opening another session — useful when you want to redirect one team without going through the chief of staff.

## State, roadmap & recovery

All orchestration state lives in one shared `.scuba/` control plane in your primary working tree — `roadmap.md` (the resume anchor), `teams/<team>/`, and `briefs/`. Every agent writes there by absolute path, so you see every spec, plan, and brief on your own branch without checking out a worktree, and the chief of staff keeps `roadmap.md` current on its monitor tick (delegating to a `scribe` when a reconciliation would block it). `roadmap.md`'s tree is a Mermaid diagram — view it on GitHub or in a mermaid-aware markdown preview (e.g. the free "Markdown Preview Mermaid Support" extension in VS Code/Cursor); a plain previewer shows it as code.

`.scuba/` is gitignored — the chief of staff makes it self-ignoring on first use (a `.scuba/.gitignore` of `*`) — so it never pollutes your code commits, and it survives a crash, an API outage, or an archived conversation because it's a real directory on disk. To survive losing the machine — and so distinct users (by git email) don't clobber each other's state — it's mirrored to a **per-user** orphan branch, pushed every heartbeat by a scribe the chief of staff dispatches. **Dispatch that scribe with git-write permission, never read-only** — a read-only scribe silently refuses the push and the off-machine copy goes stale. The state branch lives only in its **side worktree**; never check it out in the primary tree (that empties the code index for every other agent reading there). The recipe creates the orphan branch on first run (cold start):

```bash
slug=$(git config user.email | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]/-/g')   # full email, sanitized (keeps the domain)
[ -n "$slug" ] || { echo 'set a distinct git user.email first'; exit 1; }  # empty slug -> invalid ref name
branch="scuba-state/$slug"; wt="../scuba-state-$slug"                       # per-user branch AND SIDE worktree dir — never check this branch out in the primary tree
[ -d "$wt" ] || git worktree add --orphan -b "$branch" "$wt"               # cold start: create the orphan branch + side worktree once; let it fail loud (git 2.42+)
rsync -a --delete .scuba/ "$wt/.scuba/"                                     # the scribe runs this each heartbeat
git -C "$wt" add -f .scuba && git -C "$wt" commit -q -m "scuba state $(date -u +%FT%TZ)" && git -C "$wt" push -u origin "$branch"   # -f: .scuba/ is gitignored
# verify the push landed — compare local mirror SHA against the remote; surface a loud blocker if it didn't
local_sha=$(git -C "$wt" rev-parse HEAD)
remote_sha=$(git ls-remote origin "$branch" | cut -f1)
[ "$local_sha" = "$remote_sha" ] || echo "durability mirror NOT pushed — state is local-only (local $local_sha vs remote ${remote_sha:-none})"
```

If that last check prints `durability mirror NOT pushed — state is local-only`, the scribe surfaces it as a visible blocker in the roadmap's decisions section (never a footnote) and in its hand-off — a silently-stale mirror reads as durable and isn't.

Older git (no worktree `--orphan`): make the orphan branch by hand once — a detached worktree, then `git checkout --orphan` — and run the same rsync/add/commit/push/verify loop.

Recovery after a lost session is a **re-dispatch, not a reconnect** — killed workers can't be reattached. `git fetch`, restore `.scuba/` from your `scuba-state/<slug>` branch, open `roadmap.md`, and for each non-terminal thread: confirm its worktree still exists and its branch head matches the recorded last SHA, then spawn a *fresh* worker (in that node's role) with a mandate built from the node's goal, `next` step, and worktree. Treat the commands as a starting recipe — adapt to your git version and project.

**Upgrading from the old `board.md` checkpoint** _(transitional — delete this note once no project carries `board.md`)._ The roadmap is a *derived* view, so there's nothing to migrate: on first run of this version the chief of staff finds no `roadmap.md`, rebuilds it from ground truth (git branches, worktrees, PRs, and the per-team `status.md`/`decisions.md` files — all unchanged by the rename), folds any open decision noted only in a stale `.scuba/board.md` (or legacy `.orchestration/board.md`), then deletes the dead `board.md`. No fallback logic lives in the skills.

## Models

Every worker runs on Opus: the architect, the groomer (slicing epics), the hunter (adversarial finding), the intake-drafter, the senior implementer (plan execution), the bug-fixer (root-cause repair), the steward (PR-closeout disposition and merge), the researcher (gathering), the brief specialist (rendering), and the scribe (roadmap bookkeeping). Worker models are pinned in their agent files, so they're automatic. The chief of staff and managers are not pinned, because they run as the launched session and its teammates, so you must start the lead on Opus or the whole org silently drops with it.

## Cost and behavior notes

- A three-team run costs several times a single session, and direct inter-agent messages bill per round trip. The control-plane-first coordination rule in `CLAUDE.md` is what keeps that down.
- Idle teammates gray out and self-terminate to save tokens. The 15-minute heartbeat keeps your managers warm; if you want a team to stand down, just let it idle out.
- Keep the quality bar in your opening briefing to the lead. It passes that standard down to every teammate, which is your main quality lever without micromanaging.
- The `steward` owns PR closeout and resolves the external/PR threads it dispositions (the `bug-fixer` it routes a real bug to replies with the fixing commit; the steward resolves the thread). The auto-permission mode may block these `gh` writes for *relayed* findings — ones that reached the agent via you rather than as part of its named task — judging them out-of-scope. Pre-approve `gh` PR-comment writes, or fold the findings into the steward's (and bug-fixer's) mandate, so the threads close in closeout instead of routing every resolution back through you.
- Closeout re-verifies state **live** against the current head — it paginates review threads to exhaustion, reads `mergeable` per-PR (the list endpoint returns a `null` cache-miss), and pins "clean" to the head SHA, never to a cached count (per `ship-gate`; the `gh`/GraphQL commands are in the project `CLAUDE.md`).

## Shutdown

When you're done, tell the chief of staff to have the managers shut down their workers and themselves, then clean up the team. Don't leave teammates idling overnight.

## Later: the precision upgrade

When you want exact control over the heartbeat cadence and a hard guarantee that the chief of staff never blocks, the path is to move the coordination loop to the Agent SDK in TypeScript. That's API-billed rather than subscription, and it's a real build, so it's deliberately out of scope for this version. The skills and agent definitions carry straight over; only the session-driving layer changes.
