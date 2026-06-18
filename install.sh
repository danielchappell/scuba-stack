#!/usr/bin/env bash
# Scuba Stack installer. Idempotent: re-run anytime to update to the latest.
# Usage:
#   bash install.sh          # Claude target, for backward compatibility
#   bash install.sh claude
#   bash install.sh codex
#
# The source tree is platform-neutral. This script first renders a target bundle
# from targets/<target>/manifest.json, then surgically installs only Scuba-owned
# files for that target.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-claude}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to render target artifacts." >&2
  exit 1
fi

TARGET_MANIFEST="$HERE/targets/$TARGET/manifest.json"
if [ ! -f "$TARGET_MANIFEST" ]; then
  echo "Unknown target '$TARGET'. Expected a manifest at targets/$TARGET/manifest.json." >&2
  exit 2
fi

manifest_get() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keys = process.argv[2].split(".");
let value = data;
for (const key of keys) {
  if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) process.exit(3);
  value = value[key];
}
if (value == null) process.exit(3);
if (Array.isArray(value) || typeof value === "object") console.log(JSON.stringify(value));
else console.log(String(value));
' "$TARGET_MANIFEST" "$1"
}

manifest_get_optional() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keys = process.argv[2].split(".");
let value = data;
for (const key of keys) {
  if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) process.exit(0);
  value = value[key];
}
if (value == null) process.exit(0);
if (Array.isArray(value) || typeof value === "object") console.log(JSON.stringify(value));
else console.log(String(value));
' "$TARGET_MANIFEST" "$1"
}

TARGET_NAME="$(manifest_get displayName)"
HOME_DIR="$(manifest_get homeDir)"
ROOT_INSTRUCTION_FILE="$(manifest_get rootInstructionFile)"
POINTER_FILE="$(manifest_get pointerFile)"
IMPORT_LINE="$(manifest_get_optional pointerImportLine)"
ROOT_MODE="$(manifest_get rootMode)"
RENDER_SKILL_DIR="$(manifest_get skillDir)"
RENDER_AGENT_DIR="$(manifest_get agentDir)"
RENDER_PROMPT_DIR="$(manifest_get_optional promptDir)"
RENDER_HOOK_DIR="$(manifest_get hookDir)"
INSTALL_SKILL_DIR="$(manifest_get install.skillDir)"
INSTALL_AGENT_DIR="$(manifest_get install.agentDir)"
INSTALL_PROMPT_DIR="$(manifest_get_optional install.promptDir)"
INSTALL_HOOK_DIR="$(manifest_get install.hookDir)"
SETTINGS_FILE="$(manifest_get_optional settingsFile)"

DEST="$HOME/$HOME_DIR"
ROOT_MD="$DEST/$ROOT_INSTRUCTION_FILE"
POINTER="$DEST/$POINTER_FILE"
MANIFEST="$DEST/.scuba-manifest"
SKILL_DEST="$DEST/$INSTALL_SKILL_DIR"
AGENT_DEST="$DEST/$INSTALL_AGENT_DIR"
PROMPT_DEST=""
[ -z "$INSTALL_PROMPT_DIR" ] || PROMPT_DEST="$DEST/$INSTALL_PROMPT_DIR"
HOOK_DEST="$DEST/$INSTALL_HOOK_DIR"

HOOK_INSTALL="$(manifest_get_optional hooks.scuba-guard.install)"
HOOKS_ENABLED=0
if [ "$HOOK_INSTALL" = "true" ]; then HOOKS_ENABLED=1; fi
HOOK_SCRIPT="$(manifest_get_optional hooks.scuba-guard.script)"
HOOK_MATCHER="$(manifest_get_optional hooks.scuba-guard.matcher)"
HOOK_CONFIG_FILE="$(manifest_get_optional hooks.scuba-guard.configFile)"
HOOK_CONFIG_FORMAT="$(manifest_get_optional hooks.scuba-guard.configFormat)"
[ -n "$HOOK_CONFIG_FILE" ] || HOOK_CONFIG_FILE="$SETTINGS_FILE"
HOOK_CONFIG="$DEST/$HOOK_CONFIG_FILE"
HOOK_CMD=""
if [ -n "$HOOK_SCRIPT" ]; then HOOK_CMD="$HOOK_DEST/$HOOK_SCRIPT"; fi
LEGACY_IMPORT_LINES_JSON="$(manifest_get_optional legacyImportLines)"

mkdir -p "$DEST"
mkdir -p "$SKILL_DEST" "$AGENT_DEST"
[ -z "$PROMPT_DEST" ] || mkdir -p "$PROMPT_DEST"
[ "$HOOKS_ENABLED" -eq 0 ] || mkdir -p "$HOOK_DEST"

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/scuba-render.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
node "$HERE/scripts/render-target.mjs" "$TARGET" "$BUILD"

HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then HAVE_JQ=1; fi

remove_hook_config_entry() {
  local script="$1"
  [ "$HAVE_JQ" -eq 1 ] || return 0
  [ -n "$HOOK_CONFIG_FILE" ] || return 0
  [ -f "$HOOK_CONFIG" ] || return 0
  local tmp
  tmp="$(mktemp "${HOOK_CONFIG}.scuba-tmp.XXXXXX")"
  case "$HOOK_CONFIG_FORMAT" in
    claude-settings-json)
      if jq '(.hooks.PreToolUse // []) as $p
             | .hooks.PreToolUse = [ $p[]
                 | select( ((.hooks // []) | map(.command // "")
                            | any(endswith("/'"$script"'"))) | not ) ]' \
            "$HOOK_CONFIG" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$HOOK_CONFIG"
      else
        rm -f "$tmp"
      fi
      ;;
    codex-hooks-json)
      if jq '
             def event_names:
               ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact",
                "PostCompact", "UserPromptSubmit", "SubagentStop", "Stop",
                "SessionStart", "SubagentStart"];
             reduce event_names[] as $event (.;
               if has($event) then
                 .hooks[$event] = ((.hooks[$event] // []) + .[$event])
                 | del(.[$event])
               else . end
             )
             | (.hooks.PreToolUse // []) as $p
             | .hooks.PreToolUse = [ $p[]
                 | select( ((.hooks // []) | map(.command // "")
                            | any(endswith("/'"$script"'"))) | not ) ]' \
            "$HOOK_CONFIG" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$HOOK_CONFIG"
      else
        rm -f "$tmp"
      fi
      ;;
    *)
      rm -f "$tmp"
      ;;
  esac
}

# 1) Remove the org's previously installed target files from the last manifest.
if [ -f "$MANIFEST" ]; then
  while IFS= read -r entry; do
    case "$entry" in
      skill:*)         rm -rf "$SKILL_DEST/${entry#skill:}" ;;
      agent:*)         rm -f  "$AGENT_DEST/${entry#agent:}" ;;
      prompt:*)
        if [ -n "$PROMPT_DEST" ]; then
          rm -f "$PROMPT_DEST/${entry#prompt:}"
        else
          rm -f "$DEST/prompts/${entry#prompt:}"
        fi
        ;;
      hook:*)          rm -f  "$HOOK_DEST/${entry#hook:}" ;;
      settings-hook:*)
        prev_hook_script="${entry#settings-hook:}"
        if [ "$HOOKS_ENABLED" -eq 0 ] || [ "$prev_hook_script" != "$HOOK_SCRIPT" ]; then
          remove_hook_config_entry "$prev_hook_script"
        fi
        ;;
    esac
  done < "$MANIFEST"
fi

# 2) Install current skills and agents from the rendered target bundle.
: > "$MANIFEST"
for d in "$BUILD/$RENDER_SKILL_DIR"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  rm -rf "$SKILL_DEST/$name"
  cp -R "$d" "$SKILL_DEST/$name"
  echo "skill:$name" >> "$MANIFEST"
done

for f in "$BUILD/$RENDER_AGENT_DIR"/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  cp "$f" "$AGENT_DEST/$name"
  echo "agent:$name" >> "$MANIFEST"
done

if [ -n "$RENDER_PROMPT_DIR" ] && [ -n "$PROMPT_DEST" ]; then
  for f in "$BUILD/$RENDER_PROMPT_DIR"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    cp "$f" "$PROMPT_DEST/$name"
    echo "prompt:$name" >> "$MANIFEST"
  done
fi

# 3) Install and wire hooks when the target has a verified adapter.
HOOK_INSTALLED_MSG="skipped"
if [ "$HOOKS_ENABLED" -eq 1 ]; then
  for f in "$BUILD/$RENDER_HOOK_DIR"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in
      test-*|README.md|*.policy.md) continue ;;
    esac
    cp "$f" "$HOOK_DEST/$name"
    case "$name" in *.sh) chmod +x "$HOOK_DEST/$name" ;; esac
    echo "hook:$name" >> "$MANIFEST"
  done

  if [ -f "$HOOK_DEST/$HOOK_SCRIPT" ]; then
    if [ "$HAVE_JQ" -eq 1 ]; then
      base="$(mktemp "${TMPDIR:-/tmp}/scuba-hook-base.XXXXXX")"
      if [ -f "$HOOK_CONFIG" ]; then
        cp "$HOOK_CONFIG" "$base"
      else
        printf '%s\n' '{}' > "$base"
      fi
      tmp="$(mktemp "${HOOK_CONFIG}.scuba-tmp.XXXXXX")"
      case "$HOOK_CONFIG_FORMAT" in
        claude-settings-json)
          if jq --arg matcher "$HOOK_MATCHER" --arg cmd "$HOOK_CMD" --arg script "$HOOK_SCRIPT" '
                (.hooks.PreToolUse // []) as $p
                | .hooks.PreToolUse = ([ $p[]
                    | select( ((.hooks // []) | map(.command // "")
                               | any(endswith("/" + $script))) | not ) ]
                    + [ { "matcher": $matcher,
                          "hooks": [ { "type": "command", "command": $cmd } ] } ])
              ' "$base" > "$tmp" 2>/dev/null; then
            if [ -f "$HOOK_CONFIG" ] && cmp -s "$HOOK_CONFIG" "$tmp"; then
              rm -f "$tmp"
              HOOK_INSTALLED_MSG="unchanged"
            else
              [ -f "$HOOK_CONFIG" ] && cp "$HOOK_CONFIG" "$HOOK_CONFIG.scuba-bak.$(date +%Y%m%d%H%M%S)"
              mv "$tmp" "$HOOK_CONFIG"
              HOOK_INSTALLED_MSG="merged"
            fi
            echo "settings-hook:$HOOK_SCRIPT" >> "$MANIFEST"
          else
            rm -f "$tmp"
            HOOK_INSTALLED_MSG="merge-failed"
          fi
          ;;
        codex-hooks-json)
          if jq --arg matcher "$HOOK_MATCHER" --arg cmd "$HOOK_CMD" --arg script "$HOOK_SCRIPT" '
                def event_names:
                  ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact",
                   "PostCompact", "UserPromptSubmit", "SubagentStop", "Stop",
                   "SessionStart", "SubagentStart"];
                reduce event_names[] as $event (.;
                  if has($event) then
                    .hooks[$event] = ((.hooks[$event] // []) + .[$event])
                    | del(.[$event])
                  else . end
                )
                | (.hooks.PreToolUse // []) as $p
                | .hooks.PreToolUse = ([ $p[]
                    | select( ((.hooks // []) | map(.command // "")
                               | any(endswith("/" + $script))) | not ) ]
                    + [ { "matcher": $matcher,
                          "hooks": [ { "type": "command", "command": $cmd,
                                       "timeout": 30,
                                       "statusMessage": "Checking Scuba policy" } ] } ])
              ' "$base" > "$tmp" 2>/dev/null; then
            if [ -f "$HOOK_CONFIG" ] && cmp -s "$HOOK_CONFIG" "$tmp"; then
              rm -f "$tmp"
              HOOK_INSTALLED_MSG="unchanged"
            else
              [ -f "$HOOK_CONFIG" ] && cp "$HOOK_CONFIG" "$HOOK_CONFIG.scuba-bak.$(date +%Y%m%d%H%M%S)"
              mv "$tmp" "$HOOK_CONFIG"
              HOOK_INSTALLED_MSG="merged"
            fi
            echo "settings-hook:$HOOK_SCRIPT" >> "$MANIFEST"
          else
            rm -f "$tmp"
            HOOK_INSTALLED_MSG="merge-failed"
          fi
          ;;
        *)
          rm -f "$tmp"
          HOOK_INSTALLED_MSG="merge-failed"
          ;;
      esac
      rm -f "$base"
    else
      HOOK_INSTALLED_MSG="no-jq"
    fi
  fi
fi

# 4) Install pointer and wire the target root guidance.
cp "$BUILD/scuba.md" "$POINTER"
case "$ROOT_MODE" in
  import)
    if [ -f "$ROOT_MD" ]; then
      if ! grep -qF "$IMPORT_LINE" "$ROOT_MD"; then
        cp "$ROOT_MD" "$ROOT_MD.scuba-bak.$(date +%Y%m%d%H%M%S)"
        printf '\n%s\n' "$IMPORT_LINE" >> "$ROOT_MD"
      fi
    else
      printf '%s\n' "$IMPORT_LINE" > "$ROOT_MD"
    fi
    ;;
  managed-block)
    ROOT_MD="$ROOT_MD" POINTER="$POINTER" LEGACY_IMPORT_LINES_JSON="$LEGACY_IMPORT_LINES_JSON" node "$HERE/scripts/update-codex-agents.mjs"
    ;;
esac

s="$(grep -c '^skill:' "$MANIFEST" || true)"
a="$(grep -c '^agent:' "$MANIFEST" || true)"
p="$(grep -c '^prompt:' "$MANIFEST" || true)"
h="$(grep -c '^hook:' "$MANIFEST" || true)"
echo "Scuba Stack installed/updated for $TARGET_NAME: $s skills, $a agents, $p prompt(s), $h hook file(s). Safe to re-run anytime."
echo

case "$TARGET" in
  claude)
    case "$HOOK_INSTALLED_MSG" in
      merged|unchanged)
        echo "Enforcement hook wired into ~/.claude/settings.json (PreToolUse). It activates on the next terminal restart." ;;
      no-jq|merge-failed)
        echo "NOTE: jq was not available or the merge failed, so the enforcement hook was copied but not wired into ~/.claude/settings.json."
        echo "Paste this entry into .hooks.PreToolUse by hand, or install jq and re-run:"
        echo '  { "matcher": "'"$HOOK_MATCHER"'",'
        echo '    "hooks": [ { "type": "command", "command": "'"$HOOK_CMD"'" } ] }' ;;
    esac
    echo
    echo "First time only: ensure ~/.claude/settings.json has the Agent Teams flag:"
    echo '  {"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}'
    echo "then restart your terminal. Requires Claude Code v2.1.32+."
    ;;
  codex)
    case "$HOOK_INSTALLED_MSG" in
      merged|unchanged)
        echo "Codex hook adapter wired into ~/.codex/hooks.json (PreToolUse). Status: installed, pending trust."
        echo "Review and trust the hook with /hooks after restarting Codex. Treat enforcement as operational only after it is trusted and live-smoked." ;;
      no-jq|merge-failed)
        echo "NOTE: jq was not available or the merge failed, so the Codex hook adapter was copied but not wired into ~/.codex/hooks.json."
        echo "After fixing the hook config, re-run install and trust it with /hooks." ;;
      *)
        echo "Codex hook adapter was not wired. Re-run install after checking the target manifest." ;;
    esac
    echo "Start a Codex Scuba session with /prompts:scuba once after restart."
    echo "Restart Codex so ~/.codex/AGENTS.md, ~/.agents/skills, ~/.codex/agents, ~/.codex/prompts, and ~/.codex/hooks.json are reloaded."
    ;;
esac
