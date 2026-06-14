#!/usr/bin/env bash
# Scuba Stack installer. Idempotent: re-run anytime to update to the latest.
# Touches only Scuba Stack's own files under ~/.claude; your other skills, agents,
# and personal CLAUDE.md content are left alone. Your CLAUDE.md is only appended to,
# never overwritten, and is backed up before the first edit. The one settings.json
# entry it merges (the enforcement hook) is added surgically via temp-then-mv,
# leaving every other settings key untouched, and is backed up before the first edit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude"
MANIFEST="$DEST/.scuba-manifest"
POINTER="$DEST/scuba.md"
ROOT_MD="$DEST/CLAUDE.md"
IMPORT_LINE='@~/.claude/scuba.md'
SETTINGS="$DEST/settings.json"
HOOK_SCRIPT="scuba-guard.sh"                 # the enforcement hook (PreToolUse)
HOOK_MATCHER="Write|Edit|MultiEdit|NotebookEdit|Bash"
HOOK_CMD="$DEST/hooks/$HOOK_SCRIPT"          # the command settings.json points at

mkdir -p "$DEST/skills" "$DEST/agents" "$DEST/hooks"

# jq is needed only for the settings.json merge (the hook's wiring). Probe once;
# guard every jq-dependent step on it. The hook SCRIPT is copied regardless — a
# missing jq degrades the merge gracefully, it does not skip the script.
HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then HAVE_JQ=1; fi

# Remove the canonical scuba PreToolUse entry from settings.json (the inverse of
# the merge). jq-guarded; temp-then-mv (NEVER `jq f settings.json > settings.json`,
# which truncates the file before jq reads it). No-op if there's no settings file.
remove_settings_hook() {
  [ "$HAVE_JQ" -eq 1 ] || return 0
  [ -f "$SETTINGS" ] || return 0
  local tmp
  tmp="$(mktemp "${SETTINGS}.scuba-tmp.XXXXXX")"
  if jq '(.hooks.PreToolUse // []) as $p
         | .hooks.PreToolUse = [ $p[]
             | select( ((.hooks // []) | map(.command // "")
                        | any(endswith("/'"$HOOK_SCRIPT"'"))) | not ) ]' \
        "$SETTINGS" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$SETTINGS"
  else
    rm -f "$tmp"
  fi
}

# 1) Remove the org's previously installed skills/agents/hooks (surgical, from the
#    last manifest). settings-hook removal is jq-guarded and symmetric with the
#    merge: if jq is absent we skip BOTH, never removing an entry we can't re-add.
if [ -f "$MANIFEST" ]; then
  while IFS= read -r entry; do
    case "$entry" in
      skill:*)         rm -rf "$DEST/skills/${entry#skill:}" ;;
      agent:*)         rm -f  "$DEST/agents/${entry#agent:}" ;;
      hook:*)          rm -f  "$DEST/hooks/${entry#hook:}" ;;
      settings-hook:*) remove_settings_hook ;;
    esac
  done < "$MANIFEST"
fi

# 2) Install the current org skills/agents and record the new manifest.
: > "$MANIFEST"
for d in "$HERE"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "$DEST/skills/$name"
  cp -R "$d" "$DEST/skills/$name"
  echo "skill:$name" >> "$MANIFEST"
done
for f in "$HERE"/agents/*.md; do
  name="$(basename "$f")"
  cp "$f" "$DEST/agents/$name"
  echo "agent:$name" >> "$MANIFEST"
done

# 2b) Install the hook scripts (mirror the skills/agents pattern). Each is copied,
#     made executable, and manifest-recorded as hook:<name> with symmetric cleanup.
#     Test fixtures (test-*) stay in the repo for in-session verification and are
#     NOT installed into the user's runtime hooks dir.
for f in "$HERE"/hooks/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  case "$name" in test-*) continue ;; esac
  cp "$f" "$DEST/hooks/$name"
  chmod +x "$DEST/hooks/$name"
  echo "hook:$name" >> "$MANIFEST"
done

# 2c) Wire the enforcement hook into ~/.claude/settings.json — the only new
#     mechanism, applied with the same surgical/idempotent/never-clobber discipline
#     as CLAUDE.md, but MERGED (JSON can't be append-only).
#
#     N1: the settings-hook manifest line is re-recorded whenever the hook script
#     is on disk — independent of the jq guard — so the manifest always reflects
#     on-disk reality and a later jq-present run's cleanup can reconcile a merge
#     that a jq-absent run could not perform.
HOOK_INSTALLED_MSG=""
if [ -f "$DEST/hooks/$HOOK_SCRIPT" ]; then
  echo "settings-hook:$HOOK_SCRIPT" >> "$MANIFEST"
  if [ "$HAVE_JQ" -eq 1 ]; then
    # Back up settings.json once before the first edit (same as CLAUDE.md); create
    # a minimal {} if absent so the merge has a base.
    if [ -f "$SETTINGS" ]; then
      cp "$SETTINGS" "$SETTINGS.scuba-bak.$(date +%Y%m%d%H%M%S)"
    else
      printf '%s\n' '{}' > "$SETTINGS"
    fi
    tmp="$(mktemp "${SETTINGS}.scuba-tmp.XXXXXX")"
    # Read .hooks.PreToolUse with a `// []` default (the key is null/absent on a
    # fresh file; `jq -e` would exit 1 there and abort under set -e). Filter out
    # any existing scuba entry (idempotency: re-run replaces, never duplicates),
    # then append the canonical entry. Write back via temp-then-mv (atomic,
    # key-preserving). Only .hooks.PreToolUse is rewritten — every other key is
    # left exactly as the user had it (the surgical property, applied to JSON).
    if jq --arg matcher "$HOOK_MATCHER" --arg cmd "$HOOK_CMD" --arg script "$HOOK_SCRIPT" '
          (.hooks.PreToolUse // []) as $p
          | .hooks.PreToolUse = ([ $p[]
              | select( ((.hooks // []) | map(.command // "")
                         | any(endswith("/" + $script))) | not ) ]
              + [ { "matcher": $matcher,
                    "hooks": [ { "type": "command", "command": $cmd } ] } ])
        ' "$SETTINGS" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$SETTINGS"
      HOOK_INSTALLED_MSG="merged"
    else
      rm -f "$tmp"
      HOOK_INSTALLED_MSG="merge-failed"
    fi
  else
    HOOK_INSTALLED_MSG="no-jq"
  fi
fi

# 3) Wire ~/.claude/CLAUDE.md to import the pointer. APPEND-ONLY: your file is never
#    overwritten, only appended to (once), and backed up before that first edit.
cp "$HERE/global-CLAUDE.md" "$POINTER"               # the pointer is Scuba Stack's own file
if [ -f "$ROOT_MD" ]; then
  if ! grep -qF "$IMPORT_LINE" "$ROOT_MD"; then
    cp "$ROOT_MD" "$ROOT_MD.scuba-bak.$(date +%Y%m%d%H%M%S)"   # safety copy before we touch it
    printf '\n%s\n' "$IMPORT_LINE" >> "$ROOT_MD"               # append; existing content preserved
  fi
else
  printf '%s\n' "$IMPORT_LINE" > "$ROOT_MD"                    # no file yet; create it
fi

s=$(grep -c '^skill:' "$MANIFEST"); a=$(grep -c '^agent:' "$MANIFEST"); h=$(grep -c '^hook:' "$MANIFEST")
echo "Scuba Stack installed/updated: $s skills, $a agents, $h hook(s). Safe to re-run anytime."
echo
case "$HOOK_INSTALLED_MSG" in
  merged)
    echo "Enforcement hook wired into ~/.claude/settings.json (PreToolUse). It activates"
    echo "on the NEXT terminal restart — like the Agent Teams flag, hooks load at session start." ;;
  no-jq|merge-failed)
    echo "NOTE: jq was not available, so the enforcement hook was COPIED but NOT wired into"
    echo "~/.claude/settings.json. Install jq and re-run to enable it, or paste this entry into"
    echo "the .hooks.PreToolUse array in ~/.claude/settings.json by hand:"
    echo '  { "matcher": "'"$HOOK_MATCHER"'",'
    echo '    "hooks": [ { "type": "command", "command": "'"$HOOK_CMD"'" } ] }'
    echo "It activates on the next terminal restart." ;;
esac
echo
echo "First time only: ensure ~/.claude/settings.json has the Agent Teams flag:"
echo '  {"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}'
echo "then restart your terminal. Requires Claude Code v2.1.32+."
