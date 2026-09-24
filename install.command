#!/bin/bash
# Session Planner installer. Double-click it on a Mac, run `bash install.command`
# from this folder, or let your agent run it. Safe to run again at any time.
#
# It checks for Node.js and the planner's code packages, connects the planner to
# Claude Code and Codex by linking skills/session-plan into their skills folders,
# and starts the planner once on a throwaway store to prove it runs. It never
# downloads or installs anything itself.
#
# A link that already points to another existing copy of Session Planner is left
# alone, because that copy may hold the user's sessions. Pass --replace to move
# the link to this copy instead. A real file or folder is never replaced.

APP="$(cd "$(dirname "$0")" && pwd -P)" || exit 1
SKILL="$APP/skills/session-plan"
REPLACE=0
[ "$1" = "--replace" ] && REPLACE=1
problems=0
store=""

say() { printf '%s\n' "$1"; }
fail() { say ""; say "$1"; say ""; say "Nothing else was changed."; exit 1; }

say "Setting up Session Planner in $APP"
say ""
[ -f "$SKILL/SKILL.md" ] || fail "This doesn't look like a complete Session Planner folder: $SKILL/SKILL.md is missing."

# Node.js 20 or newer, as the agent will find it.
command -v node >/dev/null 2>&1 || fail "Session Planner needs Node.js, which isn't installed. Download the LTS installer from https://nodejs.org, run it, then run this again."
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$major" in
  ''|*[!0-9]*) fail "Node.js is installed but didn't report its version, so it may be broken. Reinstall the LTS version from https://nodejs.org, then run this again." ;;
esac
[ "$major" -ge 20 ] || fail "Session Planner needs Node.js 20 or newer, and this computer has $(node -v). Install the LTS version from https://nodejs.org, then run this again."
say "Node.js $(node -v): ok"

# The code packages, which come with the zip or are installed with npm ci. Node's
# warnings stay out of the answer and are shown only if the check itself fails.
packages_js='
  const deps = Object.keys(require("./package.json").dependencies);
  console.log(deps.filter(d => { try { require.resolve(d, { paths: [process.cwd()] }); return false; } catch { return true; } }).join(" "));
'
if ! missing="$(cd "$APP/server" && node -e "$packages_js" 2>/dev/null)"; then
  fail "Couldn't check the planner's code packages: $(cd "$APP/server" && node -e "$packages_js" 2>&1)"
fi
if [ -n "$missing" ]; then
  fail "The planner's code packages aren't installed (missing: $missing). In Terminal, go to the server folder inside $APP and run:

    npm ci --ignore-scripts

That installs the exact versions the planner was tested with. Then run this again."
fi
say "Code packages: ok"

# Connect each agent that is installed here.
link() {
  local name="$1" home="$2" target current was
  if [ ! -d "$home" ]; then
    say "$name: not found on this computer, skipped"
    return
  fi
  target="$home/skills/session-plan"
  if [ -L "$target" ]; then
    current="$(cd "$target" 2>/dev/null && pwd -P)"
    if [ "$current" = "$SKILL" ]; then
      say "$name: already connected"
      return
    fi
    if [ -n "$current" ] && [ "$REPLACE" -eq 0 ]; then
      say "$name: already connected to another copy of Session Planner at ${current%/skills/session-plan}. That copy may hold your sessions in its runs folder, so it was left alone. To use this copy instead, stop that copy's planner and move the session folders from its runs folder into this one's if you want to keep them, then paste this into Terminal (or ask your agent to run it):"
      say "    bash \"$APP/install.command\" --replace"
      problems=$((problems + 1))
      return
    fi
    was="$(readlink "$target")"
    if ln -sfn "$SKILL" "$target" 2>/dev/null; then
      say "$name: connected (the link pointed to $was)"
    else
      say "$name: couldn't update the link at $target"
      problems=$((problems + 1))
    fi
  elif [ -e "$target" ]; then
    say "$name: not connected. $target already exists and isn't a link. Move it somewhere else, then run this again."
    problems=$((problems + 1))
  elif mkdir -p "$home/skills" 2>/dev/null && ln -s "$SKILL" "$target" 2>/dev/null; then
    say "$name: connected"
  else
    say "$name: couldn't create the link at $target"
    problems=$((problems + 1))
  fi
}
link "Claude Code" "$HOME/.claude"
link "Codex" "$HOME/.codex"
if [ ! -d "$HOME/.claude" ] && [ ! -d "$HOME/.codex" ]; then
  say ""
  say "Session Planner works through an AI agent. Install Claude Code or Codex, open it once, then run this again to connect it."
  problems=$((problems + 1))
fi

# Start and stop the planner on a throwaway store, leaving any running planner
# alone. If this script is interrupted, the trap still stops the test planner.
stop_check() { [ -n "$store" ] && node "$APP/server/planner.js" stop --runs "$store" 2>&1; }
trap 'stop_check >/dev/null' EXIT
trap 'exit 130' INT TERM HUP
if ! store="$(mktemp -d "${TMPDIR:-/tmp}/session-planner-check.XXXXXX")"; then
  store=""
  say "Planner starts: not checked, because a temporary folder couldn't be created."
  problems=$((problems + 1))
elif started="$(node "$APP/server/planner.js" start --runs "$store" 2>&1)"; then
  stopped="$(stop_check)"
  case "$stopped" in
    *'"stopped": true'*) say "Planner starts: ok"; store="" ;;
    *) say "Planner starts: ok, but it didn't stop cleanly: $stopped"; problems=$((problems + 1)) ;;
  esac
else
  say "Planner starts: failed. $started"
  store=""
  problems=$((problems + 1))
fi

say ""
if [ "$problems" -gt 0 ]; then
  say "Setup finished with $problems problem(s) above."
  exit 1
fi
case "$APP" in
  "$HOME/Downloads"/*)
    say "This folder is inside Downloads. If you clear Downloads, the planner and your saved sessions go with it. To keep it somewhere safer, move the folder into your home folder (in Finder, choose Go, then Home) and run this again."
    say "" ;;
esac
say "Session Planner is ready. Keep this folder where it is: your agent finds the planner through it, and your sessions are saved in its runs folder."
say ""
say "To start, open a new conversation in Claude Code or Codex and ask, for example: \"Let's plan my kitchen renovation in Session Planner.\""
