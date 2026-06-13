#!/usr/bin/env bash
# Scuba Stack installer. Idempotent: re-run anytime to update to the latest.
# Touches only Scuba Stack's own files under ~/.claude; your other skills, agents,
# and personal CLAUDE.md content are left alone. Your CLAUDE.md is only appended to,
# never overwritten, and is backed up before the first edit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude"
MANIFEST="$DEST/.scuba-manifest"
POINTER="$DEST/scuba.md"
ROOT_MD="$DEST/CLAUDE.md"
IMPORT_LINE='@~/.claude/scuba.md'

mkdir -p "$DEST/skills" "$DEST/agents"

# 1) Remove the org's previously installed skills/agents (surgical, from the last manifest).
if [ -f "$MANIFEST" ]; then
  while IFS= read -r entry; do
    case "$entry" in
      skill:*) rm -rf "$DEST/skills/${entry#skill:}" ;;
      agent:*) rm -f  "$DEST/agents/${entry#agent:}" ;;
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

s=$(grep -c '^skill:' "$MANIFEST"); a=$(grep -c '^agent:' "$MANIFEST")
echo "Scuba Stack installed/updated: $s skills, $a agents. Safe to re-run anytime."
echo
echo "First time only: ensure ~/.claude/settings.json has the Agent Teams flag:"
echo '  {"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}'
echo "then restart your terminal. Requires Claude Code v2.1.32+."
