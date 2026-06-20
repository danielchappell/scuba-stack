#!/usr/bin/env bash
# Standalone fixture runner for the Codex scuba-guard.sh adapter.
#
# Run:  bash hooks/test-codex-scuba-guard.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$HERE/targets/codex/hooks/scuba-guard.sh"

PROJECT="/proj"
WORKTREE="$PROJECT/.codex/worktrees/agent-deadbeef"
CODEX_WORKTREE="$PROJECT/.codex/worktrees/codex-session-init-repair"
PRIMARY_SRC="$PROJECT/services/catalog"
REAL_WORKTREE="$HERE/.codex/worktrees/live-worker"
REAL_TRACKED_SRC="$HERE/scripts/test.mjs"
SCUBA_FILE="$PROJECT/.scuba/teams/x/status.md"
TEMP_FILE="/tmp/scuba-codex-guard/new.ts"

pass=0; fail=0

run() {
  local name="$1" expect="$2" json="$3" out got
  out="$(printf '%s' "$json" | bash "$GUARD" 2>/dev/null || true)"
  if printf '%s' "$out" | grep -q '"permissionDecision": *"deny"' 2>/dev/null \
     || printf '%s' "$out" | grep -q '"permissionDecision":"deny"' 2>/dev/null; then
    got="deny"
  else
    got="allow"
  fi
  if [ "$got" = "$expect" ]; then
    pass=$((pass+1)); printf 'ok   %-54s -> %s\n' "$name" "$got"
  else
    fail=$((fail+1)); printf 'FAIL %-54s -> got %s, want %s\n' "$name" "$got" "$expect"
  fi
}

jb() {
  jq -cn --arg command "$1" --arg cwd "$2" \
    '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$command},cwd:$cwd}'
}

ja() {
  jq -cn --arg command "$1" --arg cwd "$2" \
    '{hook_event_name:"PreToolUse",tool_name:"apply_patch",tool_input:{command:$command},cwd:$cwd}'
}

patch_add() {
  printf '*** Begin Patch\n*** Add File: %s\n+x\n*** End Patch\n' "$1"
}

patch_update() {
  printf '*** Begin Patch\n*** Update File: %s\n@@\n-old\n+new\n*** End Patch\n' "$1"
}

run "gh pr create --draft" deny \
  "$(jb 'gh pr create --draft --fill' "$WORKTREE")"

run "gh pr create -d" deny \
  "$(jb 'gh pr create -d --fill' "$WORKTREE")"

run "gh pr create --draft=true" deny \
  "$(jb 'gh pr create --draft=true --fill' "$WORKTREE")"

run "gh pr new --draft" deny \
  "$(jb 'gh pr new --draft --fill' "$WORKTREE")"

run "clean gh pr create" allow \
  "$(jb 'gh pr create --base integration --fill' "$WORKTREE")"

run "gh api draft bypass" deny \
  "$(jb 'gh api graphql -f query=mutation -f draft=true' "$WORKTREE")"

run "cd primary && git rm" deny \
  "$(jb "cd $PROJECT && git rm -rf services" "$WORKTREE")"

run "git -C primary reset" deny \
  "$(jb "git -C $PROJECT reset --hard" "$WORKTREE")"

run "apply_patch relative in worktree" allow \
  "$(ja "$(patch_add 'services/catalog/new.ts')" "$WORKTREE")"

run "apply_patch relative in codex worktree" allow \
  "$(ja "$(patch_add 'services/catalog/new.ts')" "$CODEX_WORKTREE")"

run "apply_patch absolute in worktree" allow \
  "$(ja "$(patch_update "$WORKTREE/services/catalog/app.ts")" "$WORKTREE")"

run "apply_patch relative worktree target from primary cwd" allow \
  "$(ja "$(patch_update ".codex/worktrees/live-worker/scripts/test.mjs")" "$HERE")"

run "apply_patch absolute worktree target from primary cwd" allow \
  "$(ja "$(patch_update "$REAL_WORKTREE/scripts/test.mjs")" "$HERE")"

run "apply_patch tracked source from primary cwd" deny \
  "$(ja "$(patch_update "$REAL_TRACKED_SRC")" "$HERE")"

run "apply_patch primary leak" deny \
  "$(ja "$(patch_add "$PRIMARY_SRC/leak.ts")" "$WORKTREE")"

run "apply_patch primary leak from codex worktree" deny \
  "$(ja "$(patch_add "$PRIMARY_SRC/leak.ts")" "$CODEX_WORKTREE")"

run "apply_patch .scuba" allow \
  "$(ja "$(patch_update "$SCUBA_FILE")" "$WORKTREE")"

run "apply_patch temp" allow \
  "$(ja "$(patch_add "$TEMP_FILE")" "$WORKTREE")"

run "apply_patch no file headers" allow \
  "$(ja '*** Begin Patch\n*** End Patch\n' "$WORKTREE")"

run "missing fields" allow '{}'

run "malformed json" allow '{not-json'

echo
echo "codex scuba-guard fixtures: $pass passed, $fail failed."
[ "$fail" -eq 0 ]
