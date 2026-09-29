#!/usr/bin/env node
"use strict";

/*
 * AI Co-Authoring Tracker -- Claude Code CLI activity signal.
 *
 * Registered as a global PostToolUse hook (see the "Automated setup" section of README.md) so
 * the AI Co-Authoring Tracker VS Code extension can tell "Claude Code just edited this exact file" apart
 * from "some AI tool did something somewhere in this repo" -- see startClaudeSignalWatcher /
 * handleSignal in extension.ts for how the signal this writes is consumed (freshness window,
 * matched against open documents, etc.).
 *
 * Installed and kept in sync automatically by the extension itself (syncGlobalSignalHookScript,
 * called on every activation) -- this file is the canonical source; the copy the extension
 * actually points Claude Code's hooks config at lives at
 * ~/.claude/ai-coauthoring/claude-signal-hook.js on each machine. Edit this one; the synced copy
 * is overwritten from it on the next activation, not the other way round.
 *
 * Design principles (mirrors attribution-hook.js's git-hook modes):
 *   - Must never throw past the outer try/catch, and must never write anything to stdout/stderr
 *     that Claude Code could interpret as hook failure output. A PostToolUse hook that errors or
 *     blocks would interrupt the user's actual Claude Code session -- far worse than this signal
 *     simply not getting written for one edit.
 *   - Global (not per-repo): this same file is registered once in the user's global
 *     ~/.claude/settings.json (see installGlobalSignalHook in extension.ts), so it applies to
 *     every repository Claude Code touches, not just ones that were individually set up, and to
 *     every user who installs the VS Code extension, without them hand-editing any JSON.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

// TEMPORARY: while we confirm exactly what Claude Code's PostToolUse hook payload contains (in
// particular, whether `transcript_path` is present and what shape its JSONL entries have, which
// is what per-edit model detection would read from), this dumps the full raw input alongside the
// real signal file. Once that's confirmed and real model detection is wired up from it, this
// block -- and the file it writes -- goes away. Safe to leave in the meantime: it's a plain JSON
// dump, capped in size, and wrapped so it can never break the real signal write below.
function writeDebugDump(absGitDir, input) {
  try {
    const debugPath = path.join(absGitDir, "claude-signal-debug.json");
    const serialized = JSON.stringify(input, null, 2);
    // Guard against ever writing something huge (e.g. a large tool_response) into the git dir --
    // truncate rather than skip, so there's still something useful to look at either way.
    const capped = serialized.length > 200000 ? serialized.slice(0, 200000) + "\n... (truncated)" : serialized;
    fs.writeFileSync(debugPath, capped + "\n", "utf8");
  } catch {
    // best-effort only -- never let debug capture itself break the real signal write below
  }
}

function main(input) {
  const cwd = input.cwd || process.cwd();
  const filePath = (input.tool_input && (input.tool_input.path || input.tool_input.file_path)) || "";

  const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);

  writeDebugDump(absGitDir, input);

  const signal = {
    provider: "claude",
    file: filePath,
    cwd,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(absGitDir, "claude-signal"), JSON.stringify(signal) + "\n", "utf8");
}

const rl = readline.createInterface({ input: process.stdin });
let raw = "";
rl.on("line", (line) => {
  raw += line;
});
rl.on("close", () => {
  try {
    main(JSON.parse(raw));
  } catch {
    // Hooks must never block or error out of Claude Code's own flow -- if anything above failed
    // (not a git repo, malformed input, unwritable .git dir, ...), just do nothing.
  }
  process.exit(0);
});
