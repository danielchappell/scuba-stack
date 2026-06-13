# Run-book — Operating Scuba Stack with Agent Teams

This is the operator's guide. The behavior lives in the skills and `CLAUDE.md`; this file is how you turn it on and drive it.

## One-time setup

Full install is in `INSTALL.md`; the short version:

1. **Run the installer.** From the unzipped bundle, `bash install.sh` installs the skills to `~/.claude/skills/`, the agents to `~/.claude/agents/`, and the pointer as `~/.claude/scuba.md` (imported by a single line in `~/.claude/CLAUDE.md`). User scope, so every project gets them. It's idempotent — re-run it anytime to update; it replaces only the org's files and leaves your other skills, agents, and personal `CLAUDE.md` content alone.
2. **Enable Agent Teams.** Add the flag to the `env` block of `~/.claude/settings.json`, then restart your terminal (needs Claude Code v2.1.32+):
   ```json
   { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
   ```
3. **Nothing to create per repo.** The chief of staff initializes the `.scuba/` board itself the first time you use the org in a repo. Optionally add project specifics (stack, paths, commands) to that repo's own `CLAUDE.md`.
4. **Pre-approve permissions.** Teammates inherit the lead's permission mode at spawn and their prompts bubble up to the lead, which creates friction in an always-running org. Pre-approve the common operations before spawning, and use the **default** permission mode, not delegate mode (delegate mode passes its restrictions to teammates and leaves them unable to work). For low-risk runs you can launch with `--dangerously-skip-permissions`, but only when you mean it.
5. **(Optional) Split-pane view.** Default in-process mode works in any terminal. For a pane per teammate, run inside tmux or iTerm2: `claude --teammate-mode tmux`. Split-pane isn't supported in the VS Code integrated terminal.

## Directory layout

```
~/.claude/              # user scope — installed once, shared by every project
  scuba.md              # the always-on pointer (imported by ~/.claude/CLAUDE.md)
  agents/               # worker pool: architect, bug-fixer, reviewer, senior-implementer,
                        #   researcher, intake-drafter, brief-specialist
  skills/               # chief-of-staff/, team-manager/, ship-gate/, adversarial-review/, …
  .scuba-manifest       # internal: what the installer placed, for clean reinstall

your-repo/              # per project — nothing required up front
  CLAUDE.md             # optional: project stack, paths, external-reviewer wiring
  .scuba/               # created by the chief of staff on first use
    board.md
    teams/
    briefs/
```

## Running it

1. **Start the chief of staff** as your lead session: open Claude Code **on Opus** (the lead and its manager teammates run on the session model, so this is what pins your judgment layer to Opus), tell it it's your chief of staff and to read `CLAUDE.md`, and give it your ask. Only the worker subagents set their own model in their agent files; the lead and managers do not, so launching on Sonnet silently downgrades the whole judgment layer.
2. **It dispatches at the right depth.** For a contained task or research it spins up a single worker subagent directly. For a big chunk it spawns a manager teammate, each with a full mandate in the spawn prompt (goal, constraints, deliverable, definition of done, paths, quality bar). Typical load is two to four tasks plus a researcher; managers appear only when a chunk earns one.
3. **Managers run their chunk autonomously**, spawning their own worker subagents, running the review loop, monitoring, and reporting up through the board and heartbeat.
4. **You stay talking to the chief of staff.** Hand it new asks, redirect, reprioritize. It stays free because it dispatches rather than triaging or building — if you ever see it grinding through a backlog itself, that's the bug.

## Watching and steering

- `Ctrl+T` — the shared task list across the team.
- `Shift+Up` / `Shift+Down` — move between teammates.
- `Enter` — view a teammate's session; `Escape` — interrupt.
- You can navigate straight to any manager and give it instructions directly, the same as opening another session — useful when you want to redirect one team without going through the chief of staff.

## Models

Everything that judges or writes code runs on Opus: the chief of staff, the managers, the architect, the reviewer, the senior implementer (plan execution), and the bug-fixer (root-cause repair). Only the researcher (gathering) and the brief specialist (rendering) run on Sonnet. Worker models are pinned in their agent files, so they're automatic. The chief of staff and managers are not pinned, because they run as the launched session and its teammates, so you must start the lead on Opus or the whole judgment layer silently drops with it.

## Cost and behavior notes

- A three-team run costs several times a single session, and direct inter-agent messages bill per round trip. The board-first coordination rule in `CLAUDE.md` is what keeps that down.
- Idle teammates gray out and self-terminate to save tokens. The 15-minute heartbeat keeps your managers warm; if you want a team to stand down, just let it idle out.
- Keep the quality bar in your opening briefing to the lead. It passes that standard down to every teammate, which is your main quality lever without micromanaging.
- Fix-workers (`senior-implementer`, `bug-fixer`) can resolve their own external/PR review threads, but the auto-permission mode may block the `gh` writes for *relayed* findings — ones that reached the worker via you rather than as part of its named task — judging them out-of-scope. Pre-approve `gh` PR-comment writes, or fold the findings into the worker's mandate, so it closes its own threads instead of routing every resolution back through you.

## Shutdown

When you're done, tell the chief of staff to have the managers shut down their workers and themselves, then clean up the team. Don't leave teammates idling overnight.

## Later: the precision upgrade

When you want exact control over the heartbeat cadence and a hard guarantee that the chief of staff never blocks, the path is to move the coordination loop to the Agent SDK in TypeScript. That's API-billed rather than subscription, and it's a real build, so it's deliberately out of scope for this version. The skills and agent definitions carry straight over; only the session-driving layer changes.
