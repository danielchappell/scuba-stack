#!/usr/bin/env bash
# Standalone fixture runner for scuba-guard.sh — the in-session verifiable
# sub-unit of S3 (the hook cannot be self-tested in the live harness; this
# proves the deny-rule LOGIC outside it by piping sample PreToolUse JSON in and
# asserting allow/deny).
#
# Run:  bash hooks/test-scuba-guard.sh
# Exit: 0 if every case matches its expectation, 1 otherwise.
#
# "allow" = the guard emits nothing on stdout (exit 0, normal permission flow).
# "deny"  = the guard emits a hookSpecificOutput object with permissionDecision
#           == "deny".

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$HERE/targets/claude/hooks/scuba-guard.sh"
PRIMARY_ROOT="${SCUBA_GUARD_PRIMARY_ROOT:-}"
if [ -z "$PRIMARY_ROOT" ]; then
  PRIMARY_ROOT="$(git -C "$HERE" worktree list --porcelain 2>/dev/null | awk '
    BEGIN { first = "" }
    /^worktree / {
      candidate = substr($0, 10)
      if (first == "") first = candidate
      if (candidate !~ /\/\.(codex|claude)\/worktrees\//) {
        print candidate
        found = 1
        exit
      }
    }
    END {
      if (!found && first != "") print first
    }
  ')"
fi
[ -n "$PRIMARY_ROOT" ] || PRIMARY_ROOT="$HERE"

# Two kinds of fixture paths, kept deliberately separate:
#
#  1. LOGICAL (synthetic, non-existent) paths under /proj — used for the
#     containment / whitelist / bash cases. The guard judges these by string
#     (canonicalize() falls back to the literal path when the parent doesn't
#     exist, and prefix/component matching is purely lexical), so they need no
#     real dirs. They MUST NOT be rooted under /tmp or the system temp dir (the
#     guard legitimately whitelists those), and MUST NOT be rooted under a real
#     `.claude/worktrees/agent-*` ancestor — which is exactly why we use a clean
#     synthetic /proj prefix rather than a dir beside this script (this script
#     itself lives inside a worktree, whose ancestor would contaminate the walk).
#
#  2. A REAL git repo (under TMPROOT) used ONLY for the lead "tracked code path"
#     case, which is the one branch where the guard stats the filesystem
#     (`git ls-files`). For that case cwd is set to `/` so the worktree walk-up
#     finds nothing and the lead branch is exercised.
PROJECT="/proj"
WORKTREE="$PROJECT/.claude/worktrees/agent-deadbeef"
PRIMARY_SRC="$PROJECT/services/catalog"
SCUBA_DIR="$PROJECT/.scuba/teams/x"

# Real git repo for the lead "tracked code path" case — the one branch where the
# guard stats the filesystem (`git ls-files`). It MUST live at a NON-temp path
# (the guard whitelists the system temp dir, so a temp-rooted repo would be
# allowed before the tracked-code check runs). So we root it under the primary
# repository surface, not beside this script when the script is running from a
# nested worker worktree. It's a throwaway repo (its own nested .git), removed
# on exit. cwd="/" for these cases so no worktree is resolved and the lead
# branch is exercised.
TMPROOT="$PRIMARY_ROOT/_guard_repo.$$"
rm -rf "$TMPROOT"
trap 'rm -rf "$TMPROOT"' EXIT
REPO="$TMPROOT/repo"
REPO_SRC="$REPO/services/catalog"
mkdir -p "$REPO_SRC"
git -C "$REPO" init -q 2>/dev/null || true
git -C "$REPO" config user.email t@t.t 2>/dev/null || true
git -C "$REPO" config user.name t 2>/dev/null || true
printf 'x\n' > "$REPO_SRC/app.ts"
printf '# r\n' > "$REPO/README.md"
git -C "$REPO" add -A 2>/dev/null || true
git -C "$REPO" commit -q -m init 2>/dev/null || true

pass=0; fail=0

# run <name> <expect: allow|deny> <cwd> <json>
# (The guard reads cwd from the stdin JSON, never from $PWD, so we don't cd —
# this lets us pass synthetic /proj cwds that don't exist on disk.)
run() {
  local name="$1" expect="$2" cwd="$3" json="$4" out got
  out="$(printf '%s' "$json" | bash "$GUARD" 2>/dev/null || true)"
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"' 2>/dev/null \
     || printf '%s' "$out" | grep -q '"permissionDecision":"deny"' 2>/dev/null; then
    got="deny"
  else
    got="allow"
  fi
  if [ "$got" = "$expect" ]; then
    pass=$((pass+1)); printf 'ok   %-48s -> %s\n' "$name" "$got"
  else
    fail=$((fail+1)); printf 'FAIL %-48s -> got %s, want %s\n' "$name" "$got" "$expect"
  fi
}

# JSON builders. Args are positional in the order shown.
jw() { # $1=tool $2=path $3=cwd $4=agent_id
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s"},"cwd":"%s","agent_id":"%s"}' "$1" "$2" "$3" "$4"
}
jwna() { # $1=tool $2=path $3=cwd  (no agent_id; top-level lead)
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s"},"cwd":"%s"}' "$1" "$2" "$3"
}
jnb() { # $1=notebook_path $2=cwd $3=agent_id
  printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"%s"},"cwd":"%s","agent_id":"%s"}' "$1" "$2" "$3"
}
jb() { # $1=command $2=cwd
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"},"cwd":"%s"}' "$1" "$2"
}

# --- Containment cases (subagent: agent_id present, cwd inside the worktree) ---

# In-worktree write (existing-ish path) -> allow
run "in-worktree write" allow "$WORKTREE" \
  "$(jw Write "$WORKTREE/services/catalog/new.ts" "$WORKTREE" a1)"

# New-file in-worktree write (file does not exist) -> allow (exercises [R-NOEXIST])
run "new-file in-worktree write" allow "$WORKTREE" \
  "$(jw Write "$WORKTREE/services/catalog/brand-new-file.ts" "$WORKTREE" a1)"

# Primary-tree code write from a subagent -> deny
run "primary-tree code write (subagent)" deny "$WORKTREE" \
  "$(jw Write "$PRIMARY_SRC/leak.ts" "$WORKTREE" a1)"

# .scuba/ write -> allow (component whitelist; this is every doc-agent's target)
run ".scuba/ write" allow "$WORKTREE" \
  "$(jw Write "$SCUBA_DIR/status.md" "$WORKTREE" a1)"

# Lookalike `.scuba` substring -> deny (exercises component-match [R-CONTAIN])
run "x.scuba.ts lookalike" deny "$WORKTREE" \
  "$(jw Write "$PRIMARY_SRC/x.scuba.ts" "$WORKTREE" a1)"

# MultiEdit primary-tree write -> deny (widened matcher)
run "MultiEdit primary-tree write" deny "$WORKTREE" \
  "$(jw MultiEdit "$PRIMARY_SRC/leak2.ts" "$WORKTREE" a1)"

# NotebookEdit primary-tree write -> deny (widened matcher, notebook_path)
run "NotebookEdit primary-tree write" deny "$WORKTREE" \
  "$(jnb "$PRIMARY_SRC/nb.ipynb" "$WORKTREE" a1)"

# --- Bash arm ---

# npm install from a worktree -> allow (dropped false-positive [R-BASH])
run "npm install from worktree" allow "$WORKTREE" \
  "$(jb 'npm install' "$WORKTREE")"

# gh pr create --draft -> deny
run "gh pr create --draft" deny "$WORKTREE" \
  "$(jb 'gh pr create --draft --fill' "$WORKTREE")"

# Non-mutating draft-pattern command -> deny before help can run.
run "gh pr create --draft --help" deny "$WORKTREE" \
  "$(jb 'gh pr create --draft --help' "$WORKTREE")"

# gh pr new --draft -> deny (documented alias)
run "gh pr new --draft" deny "$WORKTREE" \
  "$(jb 'gh pr new --draft --fill' "$WORKTREE")"

# clean gh pr create -> allow
run "clean gh pr create" allow "$WORKTREE" \
  "$(jb 'gh pr create --base harden/bundle --fill' "$WORKTREE")"

# cd <primary> && git rm -> deny (best-effort primary-tree mutation)
run "cd primary && git rm" deny "$WORKTREE" \
  "$(jb "cd $PROJECT && git rm -rf services" "$WORKTREE")"

# --- Lead session (no agent_id, cwd NOT inside a worktree: cwd="/") ---

# Lead writing TRACKED code in the primary tree -> deny ("lead does not write
# code"). Uses the REAL git repo so the git ls-files classifier has a tracked
# file to find; cwd="/" so no worktree is resolved.
run "lead writes tracked code (no agent_id)" deny "/" \
  "$(jwna Write "$REPO_SRC/app.ts" "/")"

# Lead writing a .md doc -> allow (doc whitelist)
run "lead writes .md doc (no agent_id)" allow "/" \
  "$(jwna Write "$REPO/README.md" "/")"

# Lead writing .scuba -> allow (component whitelist)
run "lead writes .scuba (no agent_id)" allow "/" \
  "$(jwna Write "$SCUBA_DIR/roadmap.md" "/")"

echo
echo "scuba-guard fixtures: $pass passed, $fail failed."
[ "$fail" -eq 0 ]
