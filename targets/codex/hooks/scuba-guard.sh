#!/usr/bin/env bash
# Scuba Stack Codex PreToolUse guard.
#
# This is target-native for Codex:
#   - Bash and apply_patch both carry input in tool_input.command.
#   - apply_patch may match as apply_patch, Edit, or Write, but the canonical
#     tool_name is apply_patch.
#   - Codex worker worktrees live under <project>/.codex/worktrees/<name>/.
#   - Deny by emitting Codex hookSpecificOutput JSON for PreToolUse.
#
# Infrastructure failures fail open with a loud stderr warning. Policy
# violations fail loud with a deny object.

set -euo pipefail

WORKTREES_SEGMENT=".codex/worktrees"
SCUBA_COMPONENT=".scuba"

if ! command -v jq >/dev/null 2>&1; then
  echo "scuba-codex-guard: jq not found — failing open." >&2
  exit 0
fi

INPUT="$(cat 2>/dev/null || true)"
if [ -z "$INPUT" ]; then
  echo "scuba-codex-guard: empty hook input — failing open." >&2
  exit 0
fi

if ! printf '%s' "$INPUT" | jq . >/dev/null 2>&1; then
  echo "scuba-codex-guard: malformed hook JSON — failing open." >&2
  exit 0
fi

tool_name="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
cwd="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
command_str="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"

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

canonicalize() {
  local p="$1" parent base cparent
  [ -n "$p" ] || return 1
  case "$p" in
    /*) ;;
    *) p="${cwd:-.}/$p" ;;
  esac
  [ "$p" != "/" ] && p="${p%/}"
  parent="$(dirname "$p")"
  base="$(basename "$p")"
  if [ -d "$parent" ]; then
    if cparent="$(cd "$parent" 2>/dev/null && pwd -P)"; then
      printf '%s/%s' "$cparent" "$base"
      return 0
    fi
  fi
  printf '%s' "$p"
}

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

worktree_root_for_path() {
  local p="$1" prefix rest name
  case "$p" in
    "$WORKTREES_SEGMENT"/*)
      prefix=""
      rest="${p#"$WORKTREES_SEGMENT"/}"
      ;;
    */"$WORKTREES_SEGMENT"/*)
      prefix="${p%%/"$WORKTREES_SEGMENT"/*}"
      rest="${p#"$prefix/$WORKTREES_SEGMENT/"}"
      ;;
    *) return 1 ;;
  esac
  name="${rest%%/*}"
  case "$name" in
    ""|.|..) return 1 ;;
  esac
  if [ -n "$prefix" ]; then
    printf '%s/%s/%s' "$prefix" "$WORKTREES_SEGMENT" "$name"
  else
    printf '%s/%s' "$WORKTREES_SEGMENT" "$name"
  fi
}

in_a_worktree() {
  worktree_root_for_path "$1" >/dev/null
}

allowed_worktree_root() {
  local dir="${cwd:-}" root
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if root="$(worktree_root_for_path "$dir")"; then
      printf '%s' "$root"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

under_root() {
  local p="$1" root="$2"
  [ -n "$root" ] || return 1
  case "$p/" in
    "$root"/*) return 0 ;;
  esac
  return 1
}

in_temp() {
  local p="$1"
  case "$p" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;;
  esac
  [ -n "${TMPDIR:-}" ] && case "$p" in "${TMPDIR%/}"/*) return 0 ;; esac
  return 1
}

normalize_shell_words() {
  printf '%s' "$1" | tr '\n' ' ' | sed -E "s/\\\\(.)/\\1/g; s/[\"']//g; s/([;&|()])/ \\1 /g"
}

is_shell_separator() {
  case "$1" in
    ";"|"&"|"|"|"("|")") return 0 ;;
  esac
  return 1
}

is_draft_flag() {
  local token="$1" value
  case "$token" in
    --draft|-d|-d=*) return 0 ;;
    --draft=*)
      value="${token#--draft=}"
      case "$value" in
        false|False|FALSE|0|no|No|NO) return 1 ;;
        *) return 0 ;;
      esac
      ;;
  esac
  return 1
}

is_gh_executable() {
  local token="$1" base
  base="${token##*/}"
  [ "$base" = "gh" ]
}

gh_command_index_after_globals() {
  local j="$1" token
  while [ "$j" -lt "${#words[@]}" ]; do
    token="${words[$j]}"
    is_shell_separator "$token" && return 1
    case "$token" in
      -R|--repo|--hostname|--config)
        j=$((j + 2))
        ;;
      --repo=*|--hostname=*|--config=*|--*)
        j=$((j + 1))
        ;;
      -*)
        j=$((j + 1))
        ;;
      *)
        break
        ;;
    esac
  done
  [ "$j" -lt "${#words[@]}" ] || return 1
  printf '%s' "$j"
}

has_gh_draft_pr_create() {
  local normalized token sub i j
  local -a words
  normalized="$(normalize_shell_words "$1")"
  read -r -a words <<< "$normalized"

  for ((i = 0; i < ${#words[@]}; i += 1)); do
    is_gh_executable "${words[$i]}" || continue
    if ! j="$(gh_command_index_after_globals "$((i + 1))")"; then
      continue
    fi

    [ "$j" -lt "${#words[@]}" ] || continue
    [ "${words[$j]}" = "pr" ] || continue
    j=$((j + 1))
    [ "$j" -lt "${#words[@]}" ] || continue
    sub="${words[$j]}"
    [ "$sub" = "create" ] || [ "$sub" = "new" ] || continue
    j=$((j + 1))

    while [ "$j" -lt "${#words[@]}" ]; do
      token="${words[$j]}"
      is_shell_separator "$token" && break
      is_draft_flag "$token" && return 0
      j=$((j + 1))
    done
  done

  return 1
}

has_gh_api_draft_mutation() {
  local normalized token segment i j
  local -a words
  normalized="$(normalize_shell_words "$1")"
  read -r -a words <<< "$normalized"

  for ((i = 0; i < ${#words[@]}; i += 1)); do
    is_gh_executable "${words[$i]}" || continue
    if ! j="$(gh_command_index_after_globals "$((i + 1))")"; then
      continue
    fi

    [ "$j" -lt "${#words[@]}" ] || continue
    [ "${words[$j]}" = "api" ] || continue

    segment=""
    while [ "$j" -lt "${#words[@]}" ]; do
      token="${words[$j]}"
      is_shell_separator "$token" && break
      segment="${segment} ${token}"
      j=$((j + 1))
    done

    if printf '%s' "$segment" | grep -Eiq '(draft[^[:alnum:]]*[:=]?[[:space:]]*true|convertPullRequestToDraft)'; then
      return 0
    fi
  done

  return 1
}

is_doc_path() {
  local p="$1" b
  b="$(basename "$p")"
  case "$b" in
    *.md) return 0 ;;
  esac
  return 1
}

is_tracked_code_path() {
  local p="$1" dir
  is_doc_path "$p" && return 1
  has_scuba_component "$p" && return 1
  dir="$(dirname "$p")"
  [ -d "$dir" ] || return 1
  if git -C "$dir" ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

contain_path() {
  local raw="$1" path root target_root
  [ -n "$raw" ] || return 0
  path="$(canonicalize "$raw")"

  has_scuba_component "$path" && return 0
  in_temp "$path" && return 0

  if root="$(allowed_worktree_root)"; then
    if under_root "$path" "$root"; then
      return 0
    fi
    deny "apply_patch target '$path' is outside this agent's Codex worktree ('$root'). Code writes must stay inside your own worktree; .scuba/ and temp dirs are the only exceptions."
  fi

  if target_root="$(worktree_root_for_path "$path")"; then
    return 0
  fi

  is_doc_path "$path" && return 0
  if is_tracked_code_path "$path"; then
    deny "apply_patch target '$path' is a tracked code path from the top-level session. Dispatch a worker; the lead does not write code."
  fi
  return 0
}

check_apply_patch() {
  local patch="$1" found=0 line file
  [ -n "$patch" ] || exit 0
  while IFS= read -r line; do
    case "$line" in
      "*** Add File: "*|"*** Update File: "*|"*** Delete File: "*|"*** Move to: "*)
        file="${line#*** Add File: }"
        file="${file#*** Update File: }"
        file="${file#*** Delete File: }"
        file="${file#*** Move to: }"
        contain_path "$file"
        found=1
        ;;
    esac
  done <<EOF
$patch
EOF
  [ "$found" -eq 0 ] && echo "scuba-codex-guard: apply_patch command had no file headers — failing open." >&2
  exit 0
}

check_bash() {
  local cmd="$1" cdtarget ctarget cflag
  [ -n "$cmd" ] || exit 0

  if has_gh_draft_pr_create "$cmd"; then
    deny "Draft PRs are not reviewed by the external reviewer; open a non-draft PR."
  fi

  if has_gh_api_draft_mutation "$cmd"; then
    deny "Draft PR creation or conversion through gh api is blocked by the never-draft rule."
  fi

  if printf '%s' "$cmd" | grep -Eq 'cd[[:space:]]+[^&|;]+&&[^&|;]*git[[:space:]]+(rm|checkout|reset|clean)\b'; then
    cdtarget="$(printf '%s' "$cmd" | sed -nE 's/.*cd[[:space:]]+([^&|;[:space:]]+).*/\1/p')"
    if [ -n "$cdtarget" ] && ! in_a_worktree "$cdtarget"; then
      deny "Destructive git command targets '$cdtarget', which is not a Codex worker worktree."
    fi
  fi

  if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+[[:space:]]+(rm|checkout|reset|clean)\b'; then
    cflag="$(printf '%s' "$cmd" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+([^[:space:]]+)[[:space:]]+(rm|checkout|reset|clean).*/\1/p')"
    ctarget="$(canonicalize "$cflag")"
    if [ -n "$ctarget" ] && ! in_a_worktree "$ctarget"; then
      deny "Destructive git -C command targets '$ctarget', which is not a Codex worker worktree."
    fi
  fi

  exit 0
}

case "$tool_name" in
  Bash)
    check_bash "$command_str"
    ;;
  apply_patch|Edit|Write)
    check_apply_patch "$command_str"
    ;;
  *)
    exit 0
    ;;
esac

exit 0
