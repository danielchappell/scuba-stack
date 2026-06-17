#!/usr/bin/env bash
# scuba-guard.sh — Scuba Stack's PreToolUse enforcement hook.
#
# Two enforcements, one script, dispatched by tool_name:
#   (Decision 2) Contain code Write/Edit/MultiEdit/NotebookEdit to the calling
#                agent's own worktree (whitelisting any path with a `.scuba`
#                component, plus /tmp / the system temp dir).
#   (Decision 3) Block `gh pr create --draft` / `gh pr new --draft` (draft PRs
#                are not seen by the external reviewer; the never-draft rule
#                lives canonically in the `team-manager` skill).
#
# CONTRACT (read before changing):
#   * Input is the PreToolUse stdin JSON documented at
#     https://code.claude.com/docs/en/hooks — tool_name, tool_input
#     (file_path / notebook_path / command), cwd, and — only inside a subagent —
#     agent_id / agent_type.
#   * Deny by EMITTING the full hookSpecificOutput object (with hookEventName)
#     and exiting 0 — never a bare exit 2 (the reason must reach the agent's
#     context so it can self-correct). Allow = exit 0 with no stdout.
#   * FAIL-OPEN on infrastructure gaps (no jq, unreadable input): warn loudly on
#     stderr and exit 0. A guard that bricks every tool call on a missing
#     dependency is worse than no guard. Containment itself is FAIL-LOUD: a
#     deny names the resolved paths so a harness-layout change surfaces as a
#     visible, debuggable block rather than silent corruption.
#
# S3.0 — the verify-first branch this script is wired for:
#   The whole mechanism rests on a USER-SCOPE PreToolUse hook firing on a
#   SUBAGENT's tool calls. The docs confirm agent_id is *present when the hook
#   fires inside a subagent*, but NOT that a user-scope hook fires there at all.
#   That is an out-of-session unknown (owner must verify on a restarted harness
#   with a real spawned subagent — see RUNBOOK "Enforcement hook"). This script
#   handles BOTH outcomes at runtime, so no edit is needed once it is known:
#     - agent_id PRESENT  -> allowed worktree = that agent's worktree, derived
#                            from the worktree-root convention below.
#     - agent_id ABSENT but cwd is inside a `.../worktrees/agent-*/` dir
#                         -> cwd-anchored degraded containment: allowed worktree
#                            = the worktree ancestor of cwd. Loses the
#                            "is this THIS agent's worktree" cross-check; keeps
#                            the load-bearing "is this inside *a* worktree (or
#                            .scuba) rather than the primary tree" guard.
#     - agent_id ABSENT and cwd is NOT inside a worktree (the top-level
#                            lead/CoS session) -> "the lead does not write code":
#                            allow .scuba/ and doc (.md / operator-doc) writes,
#                            deny tracked non-.md non-.scuba primary-tree code.
#
# The Bash arm is BEST-EFFORT, a second line of defense, NOT a sandbox. The
# reliable guard is the Write/Edit containment above (it fires regardless of how
# a write is phrased through a *tool*). Known UNCOVERED evasions of the Bash arm,
# stated plainly so coverage is never mistaken for completeness:
#   * git -C <primary> ...        (cwd stays in the worktree; dodges the cwd test)
#   * git mv <primary>/...        (not in the matched git-subcommand set)
#   * rm -rf <primary>/...        (no git/gh keyword)
#   * redirection / cp / tee / sed -i / printf > / python3 -c "open(...,'w')"
#                                 writing code to the primary tree (no keyword)
#   * a draft PR opened via `gh api` raw GraphQL (not `gh pr create|new`)
# These are deliberately NOT chased: chasing invites false positives (e.g. an
# npm-install block that bricks every first build) and breeds false confidence.
# The residual is covered by prose discipline (the cwd-assert lines in the
# code-writer agents and the never-draft prose rule), not by this arm.

set -euo pipefail

# --- Top-of-file constants (the one place harness conventions live) ----------

# The worktree-root convention is a single source of truth. The allowed worktree
# is <project-under-work>/.claude/worktrees/agent-<id>/ — the repo being worked
# on, derived at runtime, NOT ~/.claude and NOT the scuba bundle. We match the
# convention by the `.claude/worktrees/agent-*` path segment rather than
# hard-coding any one project root, so it holds across every project the org
# drives. A harness layout change is a one-edit change here.
WORKTREES_SEGMENT=".claude/worktrees"   # <project>/.claude/worktrees/agent-<id>/
SCUBA_COMPONENT=".scuba"                # the control-plane whitelist (COMPONENT match)

# --- Fail-open infrastructure guard: jq must be present ----------------------

if ! command -v jq >/dev/null 2>&1; then
  echo "scuba-guard: jq not found — enforcement hook is FAILING OPEN (allowing all tool calls). Install jq to enable isolation/draft-PR enforcement." >&2
  exit 0
fi

# Read stdin once. Fail open (with a loud warning) if we can't read it.
INPUT="$(cat 2>/dev/null || true)"
if [ -z "$INPUT" ]; then
  echo "scuba-guard: empty/unreadable hook input — failing open." >&2
  exit 0
fi

# --- Extract fields (// empty defaults; never `jq -e`, which aborts on null) --

tool_name="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
cwd="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
agent_id="$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')"
file_path="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
notebook_path="$(printf '%s' "$INPUT" | jq -r '.tool_input.notebook_path // empty')"
command_str="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"

# --- Helpers -----------------------------------------------------------------

# Emit the full deny object (with hookEventName) and exit 0. A deny missing
# hookEventName may be ignored -> fail-open on the deny path, defeating the
# whole mechanism.
deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# Canonicalize a path that MAY NOT EXIST YET (the dominant Write case: creating a
# new file). `realpath`/`readlink -f` on a non-existent path exits 1, which under
# this script's own `set -euo pipefail` would abort before any decision -> the
# leak sails through. So: canonicalize the EXISTING parent dir and re-append the
# basename. Never realpath/readlink -f the full not-yet-created path.
canonicalize() {
  local p="$1" parent base cparent
  # Strip a trailing slash (except a bare "/").
  [ "$p" != "/" ] && p="${p%/}"
  parent="$(dirname "$p")"
  base="$(basename "$p")"
  # Resolve the parent if it exists; otherwise fall back to the literal parent
  # (a write into a not-yet-created dir is still classifiable by prefix).
  if [ -d "$parent" ]; then
    if cparent="$(cd "$parent" 2>/dev/null && pwd -P)"; then
      printf '%s/%s' "$cparent" "$base"
      return 0
    fi
  fi
  printf '%s' "$p"
}

# True if the resolved path has an exact `.scuba` PATH COMPONENT (never a
# substring: a substring test would whitelist code files like `.../x.scuba.ts`
# or a `foo.scuba/` dir). Split on `/` and require an exact segment.
has_scuba_component() {
  local p="$1" seg
  local IFS='/'
  # shellcheck disable=SC2086
  set -- $p
  for seg in "$@"; do
    [ "$seg" = "$SCUBA_COMPONENT" ] && return 0
  done
  return 1
}

# True if the resolved path is inside a `.claude/worktrees/agent-*/` directory.
in_a_worktree() {
  case "$1" in
    */"$WORKTREES_SEGMENT"/agent-*) return 0 ;;
  esac
  return 1
}

# Resolve the allowed worktree root for the current call. Echoes the root, or
# nothing if none applies.
#   agent_id present -> the agent's worktree (matched off cwd's worktree ancestor
#       when cwd is already inside one; the convention ties agent_id to that dir).
#   agent_id absent  -> the worktree ancestor of cwd, if cwd is inside one.
# In both cases the load-bearing test is "is the write inside *a* worktree".
allowed_worktree_root() {
  local base="${cwd:-}"
  # Walk up from cwd to the nearest `.claude/worktrees/agent-<id>` directory.
  local dir="$base"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    case "$dir" in
      */"$WORKTREES_SEGMENT"/agent-*)
        printf '%s' "$dir"
        return 0
        ;;
    esac
    dir="$(dirname "$dir")"
  done
  return 1
}

# True if a path is under a given root (prefix match on canonical dirs).
under_root() {
  local p="$1" root="$2"
  [ -n "$root" ] || return 1
  case "$p/" in
    "$root"/*) return 0 ;;
  esac
  return 1
}

# True if a path is under /tmp or the system temp dir (hunters legitimately
# improvise /tmp worktrees).
in_temp() {
  local p="$1"
  case "$p" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;;
  esac
  [ -n "${TMPDIR:-}" ] && case "$p" in "${TMPDIR%/}"/*) return 0 ;; esac
  return 1
}

# True if a doc/operator path the lead may legitimately edit: any `.md` file,
# any `.scuba` component (handled by the caller), or a named operator doc.
is_doc_path() {
  local p="$1" b
  b="$(basename "$p")"
  case "$b" in
    *.md) return 0 ;;
  esac
  return 1
}

# True if a primary-tree path is a tracked CODE path: under git version control
# (`git ls-files --error-unmatch` succeeds) AND not a doc/.scuba path.
#
# N2: `git ls-files --error-unmatch` exits NONZERO for untracked/new files; an
# unguarded call would abort the hook under `set -euo pipefail`. Capture the exit
# in an `if` (nonzero == "untracked new file" signal, NOT an error) — same
# discipline as the jq/// and realpath guards.
is_tracked_code_path() {
  local p="$1" dir
  is_doc_path "$p" && return 1
  has_scuba_component "$p" && return 1
  dir="$(dirname "$p")"
  [ -d "$dir" ] || return 1
  if git -C "$dir" ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    return 0   # tracked, non-doc, non-.scuba -> a code path
  fi
  return 1     # untracked/new, or not a git repo -> not a (tracked) code path
}

# --- Containment check for the file-writing tools ----------------------------

contain_write() {
  local raw="$1" path
  [ -n "$raw" ] || exit 0   # no path to judge -> allow
  path="$(canonicalize "$raw")"

  # Whitelist: any `.scuba` component (the control-plane write target every
  # agent uses, including the doc-only agents that have no worktree) and temp.
  if has_scuba_component "$path"; then exit 0; fi
  if in_temp "$path"; then exit 0; fi

  local root
  if root="$(allowed_worktree_root)"; then
    # Subagent (agent_id present) OR cwd already inside a worktree (degraded):
    # allow writes inside that worktree, deny outside it.
    if under_root "$path" "$root"; then
      exit 0
    fi
    deny "Write to '$path' is outside this agent's worktree ('$root'). Code writes must stay inside your own worktree (the .scuba/ control plane and temp dirs are the only exceptions). Never write to the primary tree."
  fi

  # No worktree anchor: the top-level lead/CoS session. The lead does not write
  # code. Allow .scuba (already returned) and doc writes; deny tracked code.
  if is_doc_path "$path"; then exit 0; fi
  if is_tracked_code_path "$path"; then
    deny "Write to tracked code path '$path' from the top-level session is blocked: the lead does not write code — dispatch a worker (.scuba/ and .md/operator docs are allowed)."
  fi
  # Untracked, non-.md, non-.scuba file from the lead: not a tracked code path;
  # allow (creating a new doc/scratch file is fine; a new code file gets caught
  # by the worktree containment when a real code-writer subagent does it).
  exit 0
}

# --- Bash arm: best-effort primary-tree mutation + draft-PR block ------------

check_bash() {
  local cmd="$1"
  [ -n "$cmd" ] || exit 0

  # Draft-PR block (Decision 3): `gh pr create` OR the `gh pr new` alias, with
  # `--draft` or `-d`.
  if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+pr[[:space:]]+(create|new)\b'; then
    if printf '%s' "$cmd" | grep -Eq '(--draft|(^|[[:space:]])-d([[:space:]]|=|$))'; then
      deny "Draft PRs are not reviewed by the external reviewer; open non-draft (per the never-draft rule in team-manager)."
    fi
  fi

  # Best-effort primary-tree mutation: a destructive git subcommand whose
  # effective target is the primary tree, expressed as `cd <path> && git ...`.
  # This catches the literal observed `cd <primary> && git rm` family only.
  # The enumerated evasions in the header (git -C, git mv, rm -rf, redirection)
  # are NOT caught — by design; the Write/Edit containment is the real guard.
  if printf '%s' "$cmd" | grep -Eq 'cd[[:space:]]+[^&|;]+&&[^&|;]*git[[:space:]]+(rm|checkout|reset|clean)\b'; then
    # Only fire when the cd target is NOT a worktree path (i.e. it escapes to the
    # primary tree). A cd into the agent's own worktree is legitimate.
    local cdtarget
    cdtarget="$(printf '%s' "$cmd" | sed -nE 's/.*cd[[:space:]]+([^&|;[:space:]]+).*/\1/p')"
    if [ -n "$cdtarget" ] && ! in_a_worktree "$cdtarget"; then
      deny "Best-effort block: 'cd $cdtarget && git $(printf '%s' "$cmd" | grep -oE 'git[[:space:]]+(rm|checkout|reset|clean)' | head -1 | awk '{print $2}')' targets the primary tree. Run destructive git only inside your own worktree. (This arm is best-effort; see scuba-guard.sh header for known limits.)"
    fi
  fi

  exit 0
}

# --- Dispatch on tool_name ---------------------------------------------------

case "$tool_name" in
  Write|Edit|MultiEdit)
    contain_write "$file_path"
    ;;
  NotebookEdit)
    contain_write "$notebook_path"
    ;;
  Bash)
    check_bash "$command_str"
    ;;
  *)
    exit 0
    ;;
esac

exit 0
