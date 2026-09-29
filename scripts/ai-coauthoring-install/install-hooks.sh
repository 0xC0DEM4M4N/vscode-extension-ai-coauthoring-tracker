#!/usr/bin/env bash
# Installs AI Co-Authoring Tracker's git hooks for this clone. Invoked either by the VS Code extension
# (on activation, if hooks aren't installed yet) or manually: `bash scripts/ai-coauthoring-install/install-hooks.sh`.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$REPO_ROOT/.githooks"

# Refuse to clobber another hook manager (Husky, lefthook, pre-commit, etc.) that's already
# claimed core.hooksPath -- silently overwriting it would quietly disable whatever that tool
# runs (lint-staged, commit-lint...) with no obvious sign anything changed.
EXISTING_HOOKS_PATH="$(git -C "$REPO_ROOT" config --get core.hooksPath || true)"
if [ -n "$EXISTING_HOOKS_PATH" ] && [ "$EXISTING_HOOKS_PATH" != ".githooks" ]; then
  echo "core.hooksPath is already set to '$EXISTING_HOOKS_PATH' (likely managed by another tool," >&2
  echo "e.g. Husky or lefthook). Refusing to overwrite it -- installing AI Co-Authoring Tracker's hooks" >&2
  echo "here would silently disable whatever that tool runs." >&2
  echo "" >&2
  echo "To use AI Co-Authoring Tracker's commit trailers alongside your existing hook setup, add this to" >&2
  echo "your own prepare-commit-msg and post-commit hooks (see README.md, 'Commit trailers'):" >&2
  echo "  node \"$SOURCE_DIR/attribution-hook.js\" prepare-commit-msg \"\$1\" \"\${2:-}\" \"\${3:-}\" || true" >&2
  echo "  node \"$SOURCE_DIR/attribution-hook.js\" post-commit || true" >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"
cp "$SOURCE_DIR/hooks/prepare-commit-msg" "$HOOKS_DIR/prepare-commit-msg"
cp "$SOURCE_DIR/hooks/post-commit" "$HOOKS_DIR/post-commit"
cp "$SOURCE_DIR/attribution-hook.js" "$HOOKS_DIR/attribution-hook.js"
chmod +x "$HOOKS_DIR/prepare-commit-msg" "$HOOKS_DIR/post-commit" "$HOOKS_DIR/attribution-hook.js"

git -C "$REPO_ROOT" config core.hooksPath .githooks

# .githooks/ is local tooling, not project source -- make sure it never shows up as untracked
# clutter in `git status` for anyone who installs it. We deliberately do NOT touch this repo's
# own .gitignore (that would push this choice onto every contributor's working tree, and every
# clone would carry a diff nobody asked for). Instead we register it in the CURRENT USER's
# global git ignore, which only affects this one machine.
GLOBAL_EXCLUDES="$(git config --global --get core.excludesFile || true)"
if [ -z "$GLOBAL_EXCLUDES" ]; then
  GLOBAL_EXCLUDES="$HOME/.config/git/ignore_global"
  git config --global core.excludesFile "$GLOBAL_EXCLUDES"
fi
# core.excludesFile may use a literal ~, which the shell won't expand for us here since it came
# back from `git config`, not directly off the command line.
GLOBAL_EXCLUDES="${GLOBAL_EXCLUDES/#\~/$HOME}"
mkdir -p "$(dirname "$GLOBAL_EXCLUDES")" 2>/dev/null || true
touch "$GLOBAL_EXCLUDES" 2>/dev/null || true
if [ -w "$GLOBAL_EXCLUDES" ] && ! grep -qxF ".githooks/" "$GLOBAL_EXCLUDES" 2>/dev/null; then
  {
    echo ""
    echo "# Added by AI Co-Authoring Tracker (VS Code extension): hooks it installs per-repo under"
    echo "# .githooks/ are local tooling, not project source -- ignored globally so they never"
    echo "# show up as untracked files in any repo on this machine."
    echo ".githooks/"
  } >> "$GLOBAL_EXCLUDES"
  echo "Added .githooks/ to your global git ignore ($GLOBAL_EXCLUDES) -- won't show as untracked in any repo."
else
  echo "Global git ignore already covers .githooks/ (or isn't writable) -- skipping."
fi

echo "AI Co-Authoring Tracker hooks installed to .githooks/ (core.hooksPath=.githooks)."
echo "Every commit from now on gets an AI-Coauthoring trailer reflecting locally tracked"
echo "manual/Claude/Copilot character stats since your last commit on this branch."
