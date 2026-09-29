#!/usr/bin/env node
"use strict";

/*
 * AI Co-Authoring Tracker -- commit + PR attribution logic.
 *
 * This is the canonical source; scripts/ai-coauthoring-install/install-hooks.sh copies this
 * file (and the two shell wrappers in ./hooks/) into .githooks/ and points core.hooksPath at
 * it. Re-run install-hooks.sh after editing this file to update the copy that actually runs.
 *
 * Reads character-level attribution stats the VS Code extension records locally
 * (.git/ai-attribution/<branch>/char-stats.json), and either:
 *   - prepends an "AI-Coauthoring:" trailer + Co-authored-by lines to a commit message, based
 *     on what changed since the last commit (invoked by the prepare-commit-msg hook), or
 *   - snapshots current totals as the new commit baseline (invoked by post-commit), or
 *   - prints what the next commit's trailer would say, without touching anything (invoked by
 *     the extension's "Preview Commit Attribution Trailer" command), or
 *   - prints the PR attribution block for the current branch's FULL totals, without touching
 *     anything (invoked by "Preview PR Attribution Summary"), or
 *   - creates or updates a GitHub PR for the current branch via `gh`, inserting/refreshing a
 *     delimited AI-attribution block in its description (invoked by "Create/Update Pull
 *     Request with AI Attribution").
 *
 * Design principles:
 *   - The two git-hook modes (prepare-commit-msg, post-commit) never block a commit: any
 *     failure there is swallowed and the process exits 0. The user-invoked modes (preview,
 *     pr-block, update-pr) do the opposite -- they surface real errors (nonzero exit, message
 *     on stderr) so the calling VS Code command can show the user what actually went wrong.
 *   - Never fabricates data. If nothing was tracked, no trailer/block claims otherwise.
 *   - Anything built from commit-message text (which is arbitrary user-authored freeform
 *     content) is passed to child processes as argv arrays, never interpolated into a shell
 *     string, to avoid quoting/injection surprises.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const LEGACY_BRANCH_DIR = "__legacy__";

const DEFAULT_COAUTHORS = {
  claude: "Claude <noreply@anthropic.com>",
  // GitHub has no official bot identity for Copilot commit co-authorship at the time this was
  // written -- this is a placeholder. Override it via .ai-coauthoring.json at the repo root if
  // your org has a preferred address; either way it may not render as a linked account on GitHub.
  copilot: "GitHub Copilot <copilot@github.com>",
};

// Linked from the PR attribution block ("see the extension's README") so a reviewer who
// hasn't used the extension can find out what these numbers mean without leaving GitHub.
// Override via .ai-coauthoring.json's "readmeUrl" if this extension ever lives somewhere else.
const DEFAULT_README_URL =
  "https://github.com/0xC0DEM4M4N/vscode-extension-ai-coauthoring-tracker/blob/main/README.md";

// Modes invoked by git hooks themselves: must never throw past main() (see design note above).
// Everything else (preview / pr-block / update-pr) is user-invoked and should surface errors.
const HOOK_MODES = new Set(["prepare-commit-msg", "post-commit"]);

const PR_BLOCK_START = "<!-- ai-coauthoring:start -->";
const PR_BLOCK_END = "<!-- ai-coauthoring:end -->";

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function runArgs(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadConfig(repoRoot) {
  const config = readJson(path.join(repoRoot, ".ai-coauthoring.json")) || {};
  return {
    coauthors: Object.assign({}, DEFAULT_COAUTHORS, config.coauthors || {}),
    // Minimum share (%) a provider needs before it gets a Co-authored-by line. Default: any
    // nonzero contribution counts -- the AI-Coauthoring summary line always shows exact
    // percentages regardless of this setting.
    minPercentForCoauthor: typeof config.minPercentForCoauthor === "number" ? config.minPercentForCoauthor : 1,
    readmeUrl: typeof config.readmeUrl === "string" && config.readmeUrl ? config.readmeUrl : DEFAULT_README_URL,
  };
}

function getRepoRoot() {
  return run("git rev-parse --show-toplevel");
}

function getGitDir(repoRoot) {
  const dir = run(`git -C "${repoRoot}" rev-parse --git-dir`);
  return path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
}

// Reads the branch name git itself recorded when the current rebase started, if HEAD is
// currently detached because of one (interactive rebase checks out each commit directly for
// "edit"/"reword" steps). Returns null when not mid-rebase, or the file's content isn't in the
// expected "refs/heads/<branch>" form (an unnamed detached-HEAD rebase has no branch to
// attribute back to).
function resolveRebaseHeadName(gitDir) {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const headNamePath = path.join(gitDir, dir, "head-name");
    if (!fs.existsSync(headNamePath)) continue;
    try {
      const raw = fs.readFileSync(headNamePath, "utf8").trim();
      const match = raw.match(/^refs\/heads\/(.+)$/);
      if (match) return match[1];
    } catch {
      // fall through to the other rebase-state directory, then to plain HEAD resolution
    }
  }
  return null;
}

function getCurrentBranch(repoRoot) {
  // Without this, every character tracked while a rebase is in progress -- and every hook
  // lookup that runs during one, e.g. the prepare-commit-msg fired by `git commit --amend` on
  // a reword step -- would bucket under the literal branch name "HEAD" (git's abbrev-ref for a
  // detached HEAD) instead of the branch actually being rewritten, and nothing ever reads that
  // bucket again once the rebase finishes and HEAD points back at the real branch.
  const rebaseBranch = resolveRebaseHeadName(getGitDir(repoRoot));
  if (rebaseBranch) return rebaseBranch;
  return run(`git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`);
}

function getCharStatsPath(gitDir, branch) {
  return path.join(gitDir, "ai-attribution", branch, "char-stats.json");
}

function getSnapshotPath(gitDir, branch) {
  return path.join(gitDir, "ai-attribution", branch, "commit-snapshot.json");
}

// Upgrades a possibly-legacy (v1, no provider breakdown) char-stats file to the current
// { manual, byProvider, unknown } shape per file, skipping any file that doesn't exist on
// disk right now (deleted, or currently stashed away) -- same rule the VS Code extension's
// own status bar/branch report use, so a commit trailer, PR summary, or commit-snapshot
// baseline never counts characters from a file that isn't actually part of the codebase
// right now. The underlying char-stats.json record is untouched, so a file counts again
// automatically the moment it comes back.
function readNormalizedFiles(gitDir, branch, repoRoot) {
  const raw = readJson(getCharStatsPath(gitDir, branch));
  const files = {};
  if (!raw || !raw.files) return files;

  for (const [file, stats] of Object.entries(raw.files)) {
    if (repoRoot && !fs.existsSync(path.join(repoRoot, file))) continue;
    if (stats.byProvider) {
      files[file] = { manual: stats.manual || 0, byProvider: { ...stats.byProvider }, unknown: stats.unknown || 0 };
    } else {
      // v1 shape: fold "ai" + "paste" into "unknown" rather than guessing which provider
      // they belonged to.
      files[file] = { manual: stats.manual || 0, byProvider: {}, unknown: (stats.ai || 0) + (stats.paste || 0) };
    }
  }
  return files;
}

// Sums readNormalizedFiles() into repo-branch totals -- the shape every existing caller
// (computeDelta, cmdPrepareCommitMsg, preview/pr-block/update-pr) already expects.
function readTotals(gitDir, branch, repoRoot) {
  const totals = { manual: 0, byProvider: {}, unknown: 0 };
  for (const stats of Object.values(readNormalizedFiles(gitDir, branch, repoRoot))) {
    totals.manual += stats.manual;
    for (const [provider, count] of Object.entries(stats.byProvider)) {
      totals.byProvider[provider] = (totals.byProvider[provider] || 0) + count;
    }
    totals.unknown += stats.unknown;
  }
  return totals;
}

function readSnapshot(gitDir, branch) {
  const snapshot = readJson(getSnapshotPath(gitDir, branch));
  if (!snapshot) return { manual: 0, byProvider: {}, unknown: 0, files: null };
  return {
    manual: snapshot.manual || 0,
    byProvider: snapshot.byProvider || {},
    unknown: snapshot.unknown || 0,
    // null (not {}) on an old-format snapshot written before this field existed, so callers
    // can tell "no baseline recorded yet" apart from "recorded, and it was empty".
    files: snapshot.files || null,
  };
}

function diffTotals(current, baseline) {
  const clampedDiff = (a, b) => Math.max(0, a - b);
  const providers = new Set([...Object.keys(current.byProvider), ...Object.keys(baseline.byProvider)]);
  const byProvider = {};
  for (const provider of providers) {
    byProvider[provider] = clampedDiff(current.byProvider[provider] || 0, baseline.byProvider[provider] || 0);
  }
  return {
    manual: clampedDiff(current.manual, baseline.manual),
    byProvider,
    unknown: clampedDiff(current.unknown, baseline.unknown),
  };
}

function totalOf(totals) {
  return totals.manual + totals.unknown + Object.values(totals.byProvider).reduce((sum, n) => sum + n, 0);
}

// Builds the "AI-Coauthoring: manual=6% claude=34% copilot=60%" line plus any Co-authored-by
// lines. Returns null (add nothing) if nothing was tracked since the last commit.
function buildTrailer(delta, config) {
  const total = totalOf(delta);
  if (total === 0) return null;

  const pct = (n) => Math.round((n / total) * 100);
  const parts = [`manual=${pct(delta.manual)}%`];
  const coauthorLines = [];

  for (const provider of Object.keys(delta.byProvider).sort()) {
    const count = delta.byProvider[provider] || 0;
    if (count <= 0) continue;
    const percent = pct(count);
    parts.push(`${provider}=${percent}%`);
    if (percent >= config.minPercentForCoauthor && config.coauthors[provider]) {
      coauthorLines.push(`Co-authored-by: ${config.coauthors[provider]}`);
    }
  }
  if (delta.unknown > 0) {
    parts.push(`unclear=${pct(delta.unknown)}%`);
  }

  return [`AI-Coauthoring: ${parts.join(" ")}`, ...coauthorLines].join("\n");
}

// Inserts the trailer before git's auto-generated "# Please enter the commit message..."
// comment block if present, otherwise appends it at the end of the file. Idempotent: never
// adds a second trailer (e.g. on `git commit --amend --no-edit`).
function insertTrailer(messageFilePath, trailer) {
  const original = fs.readFileSync(messageFilePath, "utf8");
  if (original.includes("AI-Coauthoring:")) return;

  const lines = original.split("\n");
  const commentIndex = lines.findIndex((line) => line.startsWith("#"));

  const block = `\n\n${trailer}\n`;
  let next;
  if (commentIndex === -1) {
    next = original.replace(/\n*$/, "") + block + "\n";
  } else {
    const before = lines.slice(0, commentIndex).join("\n").replace(/\n*$/, "");
    const after = lines.slice(commentIndex).join("\n");
    next = `${before}${block}\n${after}`;
  }

  fs.writeFileSync(messageFilePath, next, "utf8");
}

function computeDelta(repoRoot) {
  const gitDir = getGitDir(repoRoot);
  const branch = getCurrentBranch(repoRoot);
  const current = readTotals(gitDir, branch, repoRoot);
  const baseline = readSnapshot(gitDir, branch);
  return { branch, gitDir, delta: diffTotals(current, baseline) };
}

function cmdPrepareCommitMsg(messageFilePath, commitSource) {
  if (!messageFilePath) return;
  if (commitSource === "merge") return; // don't tag merge commits with unrelated branch stats

  const repoRoot = getRepoRoot();
  const { delta } = computeDelta(repoRoot);
  const config = loadConfig(repoRoot);
  const trailer = buildTrailer(delta, config);
  if (!trailer) return; // nothing tracked since the last commit -- say nothing rather than guess

  insertTrailer(messageFilePath, trailer);
}

function cmdPostCommit() {
  const repoRoot = getRepoRoot();
  const gitDir = getGitDir(repoRoot);
  const branch = getCurrentBranch(repoRoot);
  const files = readNormalizedFiles(gitDir, branch, repoRoot);
  const current = { manual: 0, byProvider: {}, unknown: 0 };
  for (const stats of Object.values(files)) {
    current.manual += stats.manual;
    for (const [provider, count] of Object.entries(stats.byProvider)) {
      current.byProvider[provider] = (current.byProvider[provider] || 0) + count;
    }
    current.unknown += stats.unknown;
  }
  const snapshot = { ...current, files };
  const snapshotPath = getSnapshotPath(gitDir, branch);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

function cmdPreview() {
  const repoRoot = getRepoRoot();
  const { branch, delta } = computeDelta(repoRoot);
  const config = loadConfig(repoRoot);
  const trailer = buildTrailer(delta, config);

  if (!trailer) {
    console.log(`No AI attribution tracked on branch "${branch}" since the last commit -- nothing would be added to the next commit.`);
    return;
  }
  console.log(`Branch: ${branch}`);
  console.log("The following would be added to your next commit message:");
  console.log("");
  console.log(trailer);
}

// ---- PR attribution summary --------------------------------------------------------------
//
// Unlike the commit trailer (which is a delta since the last commit, written once and never
// touched again), the PR block reflects the branch's FULL locally-tracked totals and is meant
// to be refreshed every time you run the command -- so it's an idempotent REPLACE keyed by
// HTML comment markers, not a write-once insert.

// This script has no access to the VS Code aiCoauthoringTracker.providers setting (a standalone
// git-hook process), so a provider id it has never seen a display label for falls back to a
// simple capitalized form of the id rather than the configured label.
function capitalize(id) {
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
}

function buildAttributionBlock(totals, config, branch) {
  const total = totalOf(totals);
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));

  const lines = [PR_BLOCK_START, "## 🤖 AI Co-Authoring Tracker Attribution", ""];

  if (total === 0) {
    lines.push(`_No AI Co-Authoring Tracker data tracked locally for this branch yet -- see the [extension's README](${config.readmeUrl}) for details._`);
  } else {
    const providerIds = Object.keys(totals.byProvider).sort();
    const headerLabels = ["Manual", ...providerIds.map(capitalize), "Unclear"];
    const values = [
      `${pct(totals.manual)}%`,
      ...providerIds.map((id) => `${pct(totals.byProvider[id] || 0)}%`),
      `${pct(totals.unknown)}%`,
    ];
    lines.push(
      `_Character-level split of edits on \`${branch}\`, tracked locally by the AI Co-Authoring Tracker VS Code extension. This is local-machine data, not an audited measurement -- see the [extension's README](${config.readmeUrl})._`,
      "",
      `| ${headerLabels.join(" | ")} |`,
      `| ${headerLabels.map(() => "---").join(" | ")} |`,
      `| ${values.join(" | ")} |`
    );
  }
  lines.push(PR_BLOCK_END);
  return lines.join("\n");
}

// Replaces the content between the markers if already present (so re-running the command
// after pushing more commits refreshes the numbers), otherwise appends the block.
function mergeBodyWithBlock(existingBody, block) {
  const body = existingBody || "";
  const startIdx = body.indexOf(PR_BLOCK_START);
  const endIdx = body.indexOf(PR_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return body.slice(0, startIdx) + block + body.slice(endIdx + PR_BLOCK_END.length);
  }
  const separator = body.trim().length > 0 ? "\n\n" : "";
  return body + separator + block + "\n";
}

function readBranchTotalsForPr(repoRoot) {
  const gitDir = getGitDir(repoRoot);
  const branch = getCurrentBranch(repoRoot);
  return { branch, totals: readTotals(gitDir, branch, repoRoot) };
}

function cmdPrBlock() {
  const repoRoot = getRepoRoot();
  const { branch, totals } = readBranchTotalsForPr(repoRoot);
  const config = loadConfig(repoRoot);
  console.log(buildAttributionBlock(totals, config, branch));
}

function ghJsonPrView() {
  try {
    const output = execFileSync("gh", ["pr", "view", "--json", "number,body,url,state"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(output);
  } catch {
    return null; // most commonly: no PR exists yet for this branch
  }
}

// Creates a PR (if none exists for this branch) or edits the existing one, inserting/updating
// the AI-attribution block in its description via `gh`. Lets real `gh` errors (not
// authenticated, no remote, etc.) propagate -- this is user-invoked, so silence would just be
// confusing.
function cmdUpdatePr() {
  const repoRoot = getRepoRoot();
  const { branch, totals } = readBranchTotalsForPr(repoRoot);
  const config = loadConfig(repoRoot);
  const block = buildAttributionBlock(totals, config, branch);

  const existing = ghJsonPrView();
  const tmpFile = path.join(os.tmpdir(), `ai-coauthoring-pr-body-${process.pid}-${Date.now()}.md`);

  try {
    if (existing && existing.number) {
      const newBody = mergeBodyWithBlock(existing.body, block);
      fs.writeFileSync(tmpFile, newBody, "utf8");
      const out = runArgs("gh", ["pr", "edit", String(existing.number), "--body-file", tmpFile]);
      if (out) console.log(out);
      console.log(`Updated PR #${existing.number} (${existing.url}) with the latest AI attribution summary.`);
    } else {
      const title = runArgs("git", ["-C", repoRoot, "log", "-1", "--format=%s"]) || branch;
      const newBody = mergeBodyWithBlock("", block);
      fs.writeFileSync(tmpFile, newBody, "utf8");
      const out = runArgs("gh", ["pr", "create", "--title", title, "--body-file", tmpFile]);
      if (out) console.log(out);
      console.log("Created a new pull request with the AI attribution summary included.");
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

// Returns the OPEN PR for the current branch, or null. `gh pr view` also returns merged/closed
// PRs for a branch, which must not be treated as "a PR exists" (nothing to keep updated, and
// a fresh PR may legitimately be created for the branch).
function findOpenPr() {
  const pr = ghJsonPrView();
  return pr && pr.number && (!pr.state || pr.state === "OPEN") ? pr : null;
}

function writeBodyAndEdit(pr, block) {
  const tmpFile = path.join(os.tmpdir(), `ai-coauthoring-pr-body-${process.pid}-${Date.now()}.md`);
  try {
    fs.writeFileSync(tmpFile, mergeBodyWithBlock(pr.body, block), "utf8");
    const out = runArgs("gh", ["pr", "edit", String(pr.number), "--body-file", tmpFile]);
    if (out) console.log(out);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

// Prints {"exists":bool,"number":n,"url":"..."} so the extension can decide whether to offer
// "Create PR" or "Update PR description". Purely a read.
function cmdPrStatus() {
  const pr = findOpenPr();
  console.log(JSON.stringify(pr ? { exists: true, number: pr.number, url: pr.url } : { exists: false }));
}

// Update-only: refreshes the attribution block on the branch's OPEN PR and NEVER creates one.
// Used for the automatic after-push refresh, so it must be a quiet no-op when there is no PR.
function cmdUpdatePrOnly() {
  const repoRoot = getRepoRoot();
  const { branch, totals } = readBranchTotalsForPr(repoRoot);
  const block = buildAttributionBlock(totals, loadConfig(repoRoot), branch);
  const pr = findOpenPr();
  if (!pr) {
    console.log(`No open pull request for "${branch}" -- nothing to update (not creating one).`);
    return;
  }
  writeBodyAndEdit(pr, block);
  console.log(`Updated PR #${pr.number} (${pr.url}) with the latest AI attribution summary.`);
}

// Create-only: refuses if an open PR already exists for the branch (use update instead).
function cmdCreatePr() {
  const repoRoot = getRepoRoot();
  const { branch, totals } = readBranchTotalsForPr(repoRoot);
  const block = buildAttributionBlock(totals, loadConfig(repoRoot), branch);
  const pr = findOpenPr();
  if (pr) {
    throw new Error(`A pull request already exists for "${branch}" (#${pr.number}, ${pr.url}). Use "Update PR description" instead.`);
  }
  const tmpFile = path.join(os.tmpdir(), `ai-coauthoring-pr-body-${process.pid}-${Date.now()}.md`);
  try {
    const title = runArgs("git", ["-C", repoRoot, "log", "-1", "--format=%s"]) || branch;
    fs.writeFileSync(tmpFile, mergeBodyWithBlock("", block), "utf8");
    const out = runArgs("gh", ["pr", "create", "--title", title, "--body-file", tmpFile]);
    if (out) console.log(out);
    console.log("Created a new pull request with the AI attribution summary included.");
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

function main() {
  const [, , mode, ...rest] = process.argv;
  if (mode === "prepare-commit-msg") {
    cmdPrepareCommitMsg(rest[0], rest[1]);
  } else if (mode === "post-commit") {
    cmdPostCommit();
  } else if (mode === "preview") {
    cmdPreview();
  } else if (mode === "pr-block") {
    cmdPrBlock();
  } else if (mode === "update-pr") {
    cmdUpdatePr();
  } else if (mode === "update-pr-only") {
    cmdUpdatePrOnly();
  } else if (mode === "create-pr") {
    cmdCreatePr();
  } else if (mode === "pr-status") {
    cmdPrStatus();
  }
}

// Only run as a CLI when invoked directly (by the git hooks, or the extension's preview/PR
// commands) -- not when required as a module, e.g. for the smoke tests in
// ../attribution-hook.test.js.
if (require.main === module) {
  const mode = process.argv[2];
  try {
    main();
  } catch (error) {
    if (HOOK_MODES.has(mode)) {
      // Git hooks must never block a commit -- swallow and exit clean.
      if (process.env.AI_COAUTHORING_DEBUG) console.error(error);
      process.exit(0);
    }
    // User-invoked commands (preview, pr-block, update-pr) should surface real errors so the
    // calling VS Code command can show the user what actually went wrong.
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  diffTotals,
  buildTrailer,
  insertTrailer,
  totalOf,
  buildAttributionBlock,
  mergeBodyWithBlock,
  PR_BLOCK_START,
  PR_BLOCK_END,
};
