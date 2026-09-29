import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execFile } from "child_process";

// Test edit: multi-line insertion added by an AI assistant to verify auto-detection
// triggers correctly for a second file in the running Extension Development Host.

type Provider = string;

// A provider the extension knows to listen for: an id used as the storage/lookup key, a
// display label, a color for charts (sidebar summary + branch report), and, optionally, the
// VS Code extension id(s) whose activity marks this provider "in use" for auto-detection.
// Claude has none -- unlike Copilot, its CLI isn't a VS Code extension the editor can see, so
// it's the fallback when nothing else matches (see guessProviderForAutoDetection).
type ProviderConfig = {
  id: string;
  label: string;
  color: string;
  detectExtensionIds?: string[];
};

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: "claude", label: "Claude", color: "#b180d7" },
  { id: "copilot", label: "Copilot", color: "#89d185", detectExtensionIds: ["GitHub.copilot", "GitHub.copilot-chat"] },
];

function isValidProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.trim().length === 0) return false;
  if (typeof v.label !== "string" || v.label.trim().length === 0) return false;
  if (typeof v.color !== "string" || v.color.trim().length === 0) return false;
  if (v.detectExtensionIds !== undefined) {
    if (!Array.isArray(v.detectExtensionIds) || !v.detectExtensionIds.every((id) => typeof id === "string")) return false;
  }
  return true;
}

// The full, current list of providers to listen for -- claude/copilot by default, plus
// whatever the user has appended (or overridden colors/labels for) via aiCoauthoringTracker.providers.
// Falls back to the built-in defaults on anything malformed (missing id/label/color, wrong
// types) rather than partially trusting a broken entry -- the same "never let a bad setting
// wedge attribution" posture as every other getConfiguration() call in this file.
function getConfiguredProviders(): ProviderConfig[] {
  const raw = vscode.workspace.getConfiguration("aiCoauthoringTracker").get<unknown>("providers", DEFAULT_PROVIDERS);
  if (!Array.isArray(raw)) return DEFAULT_PROVIDERS;
  const valid = raw.filter(isValidProviderConfig);
  return valid.length > 0 ? valid : DEFAULT_PROVIDERS;
}

function findProviderConfig(provider: Provider): ProviderConfig | undefined {
  return getConfiguredProviders().find((p) => p.id === provider);
}

function providerColor(provider: Provider): string {
  return findProviderConfig(provider)?.color ?? "var(--vscode-descriptionForeground)";
}

type AttributionState = {
  branch: string;
  filesByProvider: Partial<Record<Provider, string[]>>;
  updatedAt: string;
};

type ActiveSession = {
  provider: Provider;
  expiresAt: number;
  reason: string;
};

// How long a claude-signal write is trusted at all. Guards against a stale/leftover
// claude-signal file being replayed by directory-level watcher noise in a busy .git dir --
// without this, ANY spurious re-fire of the fs.watch callback (not necessarily caused by a
// real new write) would be treated as fresh evidence.
const CLAUDE_SIGNAL_FRESHNESS_WINDOW_MS = 10000;

type CharClass = "manual" | "ai" | "paste";

type ProviderCharCounts = Partial<Record<Provider, number>>;

// v2 shape: ai/paste characters are attributed to whichever provider had an active session at
// the time (see trackCharacterStats), so we can report real "claude X% / copilot Y%" splits
// instead of one undifferentiated "AI" bucket. "unknown" holds ai/paste-shaped characters where
// no session was active to attribute them to -- an honest bucket, not a guess.
type FileCharStats = {
  manual: number;
  byProvider: ProviderCharCounts;
  unknown: number;
  lastModified: string;
};

// Legacy v1 shape (no provider breakdown), kept only so old on-disk files can still be read.
type LegacyFileCharStatsV1 = {
  manual: number;
  ai: number;
  paste: number;
  lastModified: string;
};

type CharStatsState = {
  version: number;
  files: Record<string, FileCharStats>;
};

// Per-file breakdown written into commit-snapshot.json as of the CmdPostCommit (attribution-
// hook.js) that runs after every commit -- the baseline reconcileDiscardedFiles() rolls a
// file's live stats back to when its uncommitted changes turn out to have been discarded.
// Optional/absent on an old-format snapshot (written before this field existed), which
// reconcileDiscardedFiles() treats as "no baseline available, don't touch this branch yet".
type CommitSnapshotFileStats = {
  manual: number;
  byProvider: ProviderCharCounts;
  unknown: number;
};

type CommitSnapshot = {
  manual: number;
  byProvider: ProviderCharCounts;
  unknown: number;
  files?: Record<string, CommitSnapshotFileStats>;
};

// How long an attribution session stays active with no further activity before it expires
// and the extension falls back to auto-detection/no-attribution again. Configurable because
// "too long" depends on how the person actually works -- e.g. waiting several minutes for a
// multi-step Claude Code task to finish is normal, and losing the active provider partway
// through that wait was the exact bug this setting exists to fix.
const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;

// A single content change this large/multi-line is treated as a programmatic (AI-applied) edit rather than typing.
const AUTO_DETECT_MIN_LINES = 2;
const AUTO_DETECT_MIN_CHARS = 200;

// How soon after a tracked insertion an equal-and-opposite deletion (Ctrl+Z, or selecting the
// same text and pressing Delete) is treated as "you rejected that" and its character count is
// reversed, instead of just being silently ignored like any other deletion. Deliberately short:
// this is for the "oops, undo" reaction, not "I kept it around for ten minutes then removed it."

// Character-level attribution defaults (mirrors TraceAI's heuristic thresholds).
const DEFAULT_PASTE_THRESHOLD = 10;
const DEFAULT_AI_TIMING_MS = 50;
const DEFAULT_IMMEDIATE_UNDO_WINDOW_MS = 10000;
// How long a session that a claude-signal started or switched stays immune to being
// re-guessed by the weak "is the Copilot extension active" shape heuristic (see
// isSessionProtectedFromReguess). Deliberately separate from CLAUDE_SIGNAL_FRESHNESS_WINDOW_MS,
// which governs whether one INCOMING signal is trusted at all -- this one governs how long the
// SESSION that signal already produced keeps resisting the shape heuristic afterward, so that
// switching back to genuinely editing with Copilot doesn't stay misattributed to Claude for the
// rest of the (much longer) session TTL just because Claude Code touched a file a while ago.
const DEFAULT_CLAUDE_SIGNAL_SESSION_PROTECTION_MS = 30000;

// How long after git touches (or releases) .git/index.lock to treat any editor content
// change as "git rewrote this, not a person or an AI tool" and ignore it entirely. Covers
// stash, stash pop, checkout, pull, merge, rebase, reset, and commit -- anything that locks
// the index -- without needing to know which specific operation ran. A window rather than a
// precise "operation in progress" flag because index.lock can come and go faster than we can
// reliably observe both edges, especially for small repos/fast disks.
const DEFAULT_GIT_OPERATION_QUIET_WINDOW_MS = 3000;
const STATS_PERSIST_DEBOUNCE_MS = 1000;
// How long to wait after the LAST index.lock change before checking whether any file's
// discarded uncommitted changes should roll its live stats back (see reconcileDiscardedFiles).
const GIT_OPERATION_RECONCILE_DEBOUNCE_MS = 1000;

// Directory name (under .git/ai-attribution/) that holds character stats recorded before
// per-branch tracking existed. Kept separate and clearly labeled rather than silently
// discarded or misattributed to whatever branch happens to be checked out during migration.
const LEGACY_BRANCH_DIR = "__legacy__";

let activeSession: ActiveSession | null = null;
// When activeSession's PROVIDER (not just its TTL) was last actually set -- by a manual
// command, a fresh auto-detect, or a claude-signal switch. Lets handleSignal tell "this
// signal reflects Claude Code activity that happened before the user's last manual/auto
// choice, so it must not override it" apart from "this signal is genuinely newer evidence".
let activeProviderSetAt = 0;
// The last time a FRESH, accepted claude-signal fired, regardless of which handleSignal
// branch it took -- i.e. "how recently do we have real evidence Claude Code was active",
// as opposed to activeProviderSetAt ("when was the session's provider last actually
// changed"). Used by isSessionProtectedFromReguess to let a claude-signal-backed session
// eventually release its grip once that evidence goes stale -- see there for why.
let lastClaudeSignalAcceptedAt = 0;
let statusBar: vscode.StatusBarItem;
let statsStatusBar: vscode.StatusBarItem;
let statsTreeProvider: AiStatsTreeDataProvider;
let statsOutputChannel: vscode.OutputChannel;
let debugOutputChannel: vscode.OutputChannel;
let claudeSignalWatcher: fs.FSWatcher | null = null;
let headWatcher: fs.FSWatcher | null = null;
let gitOperationWatcher: fs.FSWatcher | null = null;
let remoteRefWatcher: fs.FSWatcher | null = null;
let remoteRefDebounceTimer: NodeJS.Timeout | undefined;
let prAutoUpdateRunning = false;
let prAutoUpdatePending = false;
let prAutoUpdateFailureShown = false;
// Whether the current branch has an OPEN pull request, as last reported by `gh` (via the
// attribution script's pr-status mode). "unknown" until the first async check finishes.
let prState: "unknown" | "none" | "open" = "unknown";
let lastGitOperationAt = 0;

// Set once in activate(). Fallback source for scripts/ai-coauthoring-install/ when the
// workspace repo doesn't ship its own copy -- see findInstallHooksScript/findAttributionHookScript.
let extensionInstallPath = "";

// Cached so the per-keystroke character-stats path never has to spawn a git subprocess.
// Invalidated/refreshed only when .git/HEAD actually changes (see startHeadWatcher).
let cachedGitDir: string | null = null;
let cachedBranch: string | null = null;

// In-memory charStats always represents the CURRENTLY ACTIVE branch only (see loadCharStatsForBranch).
const charStats = new Map<string, FileCharStats>();
const lastEditAt = new Map<string, number>();

// The most recent character-stats-recorded insertion per document (keyed by
// document.uri.toString()), so an immediate undo/delete of exactly that text can reverse the
// count it added instead of leaving it permanently attributed. Deliberately a single slot, not a
// stack: it only ever reverses the ONE most recent insertion, not an arbitrary chain of undos --
// see findImmediateUndoMatches.
type RecordedInsertion = {
  relativePath: string;
  bucket: { kind: "manual" } | { kind: "provider"; provider: Provider } | { kind: "unknown" };
  count: number;
  rangeOffset: number;
  recordedAt: number;
};
const lastInsertionByDocument = new Map<string, RecordedInsertion>();
let statsLoadedForBranch: string | null = null;
let statsPersistTimer: ReturnType<typeof setTimeout> | undefined;
// Debounced separately from statsPersistTimer: reconcileDiscardedFiles() only needs to run
// once, after a git operation has fully settled (see startGitOperationWatcher), not on every
// individual index.lock edge that operation happens to produce.
let gitOperationReconcileTimer: ReturnType<typeof setTimeout> | undefined;
let branchReportPanel: vscode.WebviewPanel | undefined;

function isAutoDetectEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<boolean>("autoDetect", true);
}

function isDebugLoggingEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<boolean>("debugLogging", false);
}

// Cheap, opt-in tracing for "why did/didn't this edit get attributed the way it did" reports --
// off by default so normal typing never pays for it or spams the Output panel. Toggle with the
// aiCoauthoringTracker.toggleDebugLogging command (or the aiCoauthoringTracker.debugLogging setting directly).
function debugLog(message: string) {
  if (!isDebugLoggingEnabled() || !debugOutputChannel) return;
  const ts = new Date().toISOString().slice(11, 23);
  debugOutputChannel.appendLine(`[${ts}] ${message}`);
}

// Reports exactly what VS Code sees for every installed extension whose id mentions "copilot",
// including whether each one is active yet -- guessProviderForAutoDetection() only ever checks
// GitHub.copilot / GitHub.copilot-chat, so if Copilot ships under a different id on this machine,
// or simply hasn't activated yet when a large edit lands, this is where that would show up.
function describeCopilotExtensions(): string {
  const matches = vscode.extensions.all.filter((ext) => ext.id.toLowerCase().includes("copilot"));
  if (matches.length === 0) return "no installed extension id contains \"copilot\"";
  return matches.map((ext) => `${ext.id}(active=${ext.isActive})`).join(", ");
}

function guessProviderForAutoDetection(): Provider {
  const providers = getConfiguredProviders();
  for (const p of providers) {
    if (!p.detectExtensionIds?.length) continue;
    if (p.detectExtensionIds.some((id) => vscode.extensions.getExtension(id)?.isActive)) return p.id;
  }
  const fallback = providers.find((p) => !p.detectExtensionIds?.length) ?? providers[0];
  return fallback.id;
}

function looksLikeAiEdit(
  event: vscode.TextDocumentChangeEvent,
  ignore: Set<vscode.TextDocumentContentChangeEvent>
): boolean {
  if (event.contentChanges.length === 0) return false;
  return event.contentChanges.some((change) => {
    // An immediate undo/delete of our own tracked insertion is a rejection, not a new AI-shaped
    // edit -- without this, undoing a large AI-applied block would look identical (by size alone)
    // to applying one, and could auto-start or extend a session for an edit that nets to nothing.
    if (ignore.has(change)) return false;
    const lineCount = change.text.split("\n").length - 1;
    return lineCount >= AUTO_DETECT_MIN_LINES || change.text.length >= AUTO_DETECT_MIN_CHARS || change.rangeLength >= AUTO_DETECT_MIN_CHARS;
  });
}

function isCharacterStatsEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<boolean>("enableCharacterStats", true);
}

function getPasteThreshold(): number {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<number>("pasteThreshold", DEFAULT_PASTE_THRESHOLD);
}

function getAiTimingThresholdMs(): number {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<number>("aiTimingThresholdMs", DEFAULT_AI_TIMING_MS);
}

function getImmediateUndoWindowMs(): number {
  return vscode.workspace
    .getConfiguration("aiCoauthoringTracker")
    .get<number>("immediateUndoWindowMs", DEFAULT_IMMEDIATE_UNDO_WINDOW_MS);
}

function getGitOperationQuietWindowMs(): number {
  return vscode.workspace
    .getConfiguration("aiCoauthoringTracker")
    .get<number>("gitOperationQuietWindowMs", DEFAULT_GIT_OPERATION_QUIET_WINDOW_MS);
}

function getClaudeSignalSessionProtectionMs(): number {
  return vscode.workspace
    .getConfiguration("aiCoauthoringTracker")
    .get<number>("claudeSignalSessionProtectionMs", DEFAULT_CLAUDE_SIGNAL_SESSION_PROTECTION_MS);
}

function getSessionTtlMs(): number {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<number>("sessionTtlMs", DEFAULT_SESSION_TTL_MS);
}

// A session must never be silently overridden by the shape heuristic's coarse "is the
// Copilot extension active" guess -- that guess is a near-permanent environment fact (most
// people with Copilot installed have it active essentially always), so letting it re-fire
// unconditionally on every large edit would make Claude attribution nearly impossible to
// sustain: any manual or plain auto-detected "claude" session would flip to "copilot" on the
// very next large edit. So a manual choice, or a session the WEAK heuristic itself produced
// (reason !== "claude-signal hook"), stays protected unconditionally, same as always.
//
// A claude-signal-backed session is different: it started from real, specific evidence
// ("Claude Code touched exactly this file just now"), not a guess -- so it's protected too,
// but only for as long as that evidence stays fresh (see lastClaudeSignalAcceptedAt). Once it
// goes stale, the session is no longer sure it's still describing what's actually happening,
// so the next large edit is free to re-guess -- letting a genuine switch back to Copilot
// reclaim attribution, instead of staying stuck on "claude" for the rest of the session TTL.
function isSessionProtectedFromReguess(): boolean {
  if (!activeSession) return false;
  if (activeSession.reason !== "claude-signal hook") return true;
  return Date.now() - lastClaudeSignalAcceptedAt < getClaudeSignalSessionProtectionMs();
}

function isWithinGitOperationQuietWindow(): boolean {
  return Date.now() - lastGitOperationAt < getGitOperationQuietWindowMs();
}

// Pure detection pass, no side effects: which of this event's deletions exactly undo the most
// recently recorded insertion on the same document (same start offset, same length, text.length
// === 0, within the immediate-undo window)? Run BEFORE handleTextDocumentChangeEvent so its
// looksLikeAiEdit check can treat a matched deletion as "not a new AI-shaped edit" rather than
// accidentally auto-starting a session because a large deletion looks the same size as a large
// paste. The actual charStats reversal happens later, inside trackCharacterStats, which is where
// branch/session context already lives.
function findImmediateUndoMatches(
  event: vscode.TextDocumentChangeEvent
): Set<vscode.TextDocumentContentChangeEvent> {
  const matches = new Set<vscode.TextDocumentContentChangeEvent>();
  const key = event.document.uri.toString();
  const pending = lastInsertionByDocument.get(key);
  if (!pending) return matches;

  const windowMs = getImmediateUndoWindowMs();
  for (const change of event.contentChanges) {
    if (change.text.length !== 0) continue; // not a pure deletion
    if (change.rangeOffset !== pending.rangeOffset) continue;
    if (change.rangeLength !== pending.count) continue;
    if (Date.now() - pending.recordedAt > windowMs) continue;
    matches.add(change);
    break; // the single tracked slot can only ever match one deletion
  }
  return matches;
}

// Classifies one content change as manual typing, an AI completion, or a paste, based on size/shape and typing speed.
function classifyContentChange(change: vscode.TextDocumentContentChangeEvent, deltaMs: number): CharClass | null {
  const text = change.text;
  if (text.length === 0) return null; // pure deletion, not attributed

  const lineCount = text.split("\n").length - 1;
  const isNewlineWithIndentOnly = lineCount === 1 && /^\r?\n[ \t]*$/.test(text);
  if (isNewlineWithIndentOnly) return "manual";

  const pasteThreshold = getPasteThreshold();
  if (lineCount >= 1 || text.length >= pasteThreshold) return "paste";
  if (text.length === 1) return "manual";

  return deltaMs < getAiTimingThresholdMs() ? "ai" : "manual";
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0];
}

function getRepoRoot(): string | null {
  const folder = getWorkspaceFolder();
  return folder?.uri.fsPath ?? null;
}

function getGitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--git-dir"]);
}

function getCurrentBranch(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function resolveGitPath(repoRoot: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(repoRoot, gitPath);
}

function getCachedGitDir(repoRoot: string): string {
  if (!cachedGitDir) {
    cachedGitDir = resolveGitPath(repoRoot, getGitDir(repoRoot));
  }
  return cachedGitDir;
}

// Reads .git/HEAD directly instead of spawning `git`, so this is cheap enough to call on
// every keystroke if needed. Falls back to the authoritative (but slower) git call only for
// detached HEAD or if HEAD can't be parsed -- both rare, one-off cases.
function resolveBranchFromHead(repoRoot: string): string {
  const gitDir = getCachedGitDir(repoRoot);
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (match) return match[1];
  } catch {
    // fall through
  }
  // Detached HEAD -- most commonly mid-rebase (interactive rebase checks out each commit
  // directly for "edit"/"reword" steps, rather than staying on a symbolic ref). Without this,
  // every character tracked while a rebase is in progress -- and every hook lookup that runs
  // during one, e.g. the prepare-commit-msg fired by `git commit --amend` on a reword step --
  // would bucket under the literal branch name "HEAD" instead of the branch actually being
  // rewritten, and nothing ever reads that bucket again once the rebase finishes and HEAD
  // points back at the real branch. Git itself records which branch is being rewritten in
  // rebase-merge/head-name (interactive) or rebase-apply/head-name (non-interactive) for
  // exactly this reason, so prefer that before falling back to the literal "HEAD".
  const rebaseBranch = resolveRebaseHeadName(gitDir);
  if (rebaseBranch) return rebaseBranch;
  try {
    return getCurrentBranch(repoRoot);
  } catch {
    return "HEAD";
  }
}

// Reads the branch name git itself recorded when the current rebase started, if HEAD is
// currently detached because of one. Returns null when not mid-rebase (both files absent) or
// if the file exists but isn't in the expected "refs/heads/<branch>" form (e.g. an unnamed
// detached-HEAD rebase, which has no branch to attribute back to).
function resolveRebaseHeadName(gitDir: string): string | null {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const raw = fs.readFileSync(path.join(gitDir, dir, "head-name"), "utf8").trim();
      const match = raw.match(/^refs\/heads\/(.+)$/);
      if (match) return match[1];
    } catch {
      // not in that kind of rebase (or no head-name file) -- try the other, then fall through
    }
  }
  return null;
}

function getCurrentBranchCached(repoRoot: string): string {
  if (cachedBranch === null) {
    cachedBranch = resolveBranchFromHead(repoRoot);
  }
  return cachedBranch;
}

// Detects branch switches (checkout/switch/rebase --onto, etc.) by watching .git/HEAD, so the
// per-keystroke hot path (trackCharacterStats) never has to ask git "what branch am I on" itself.
function startHeadWatcher(repoRoot: string) {
  if (headWatcher) return;
  const gitDir = getCachedGitDir(repoRoot);
  try {
    headWatcher = fs.watch(gitDir, (_eventType: string, filename: string | null) => {
      if (filename !== "HEAD") return;
      const previousBranch = cachedBranch;
      cachedBranch = resolveBranchFromHead(repoRoot);
      if (cachedBranch !== previousBranch) {
        onBranchChanged(repoRoot, previousBranch, cachedBranch);
      }
    });
  } catch {
    // git dir not watchable -- branch changes won't be detected live, but getCurrentBranchCached()
    // still resolves correctly the next time the cache is empty (e.g. after a reload).
  }
}

function stopHeadWatcher() {
  headWatcher?.close();
  headWatcher = null;
}

// git locks the index (creates .git/index.lock, then removes it when done) for essentially
// every operation that can rewrite tracked files out from under an open editor: stash, stash
// pop/apply, checkout, pull, merge, rebase, reset, commit. Either edge (created or removed)
// opens/extends a short quiet window (see isWithinGitOperationQuietWindow) during which edits
// are ignored entirely -- without this, git reverting or restoring a file's content looks
// exactly like a human paste or an AI-applied diff to onDidChangeTextDocument, and would get
// auto-detected and/or double-counted as if someone had just typed or pasted it.
function startGitOperationWatcher(repoRoot: string) {
  if (gitOperationWatcher) return;
  const gitDir = getCachedGitDir(repoRoot);
  try {
    gitOperationWatcher = fs.watch(gitDir, (_eventType: string, filename: string | null) => {
      if (filename !== "index.lock") return;
      lastGitOperationAt = Date.now();
      debugLog("index.lock changed: opening git-operation quiet window (stash/checkout/pull/merge/rebase/reset/commit)");

      // index.lock can appear and disappear more than once for a single git operation, so
      // debounce rather than reconciling on every edge -- run reconcileDiscardedFiles() once,
      // GIT_OPERATION_RECONCILE_DEBOUNCE_MS after the LAST index.lock change, once the
      // operation has actually settled and the working tree reflects its final state.
      if (gitOperationReconcileTimer) clearTimeout(gitOperationReconcileTimer);
      gitOperationReconcileTimer = setTimeout(() => reconcileDiscardedFiles(repoRoot), GIT_OPERATION_RECONCILE_DEBOUNCE_MS);
    });
  } catch {
    // git dir not watchable -- same fallback as the other git-dir watchers: this just won't
    // catch git-driven rewrites live, nothing else is affected.
  }
}

function stopGitOperationWatcher() {
  gitOperationWatcher?.close();
  gitOperationWatcher = null;
  if (gitOperationReconcileTimer) {
    clearTimeout(gitOperationReconcileTimer);
    gitOperationReconcileTimer = undefined;
  }
}

function getStatePath(repoRoot: string, branch: string): string {
  return path.join(getCachedGitDir(repoRoot), "ai-attribution", branch, "state.json");
}

function getCharStatsPath(repoRoot: string, branch: string): string {
  return path.join(getCachedGitDir(repoRoot), "ai-attribution", branch, "char-stats.json");
}

function getCommitSnapshotPath(repoRoot: string, branch: string): string {
  return path.join(getCachedGitDir(repoRoot), "ai-attribution", branch, "commit-snapshot.json");
}

// Handles "if i discard the changes in the file, the numbers dont change in the summary":
// git hooks only fire for commit/merge/rebase-shaped operations, never for a plain
// `git checkout -- <file>` / `git restore <file>` / Source-Control-view discard, so there's
// no dedicated signal to react to. Instead of trying to classify WHICH operation just ran,
// this compares two independently-knowable facts for every file the last commit snapshotted:
// does its current content have zero diff vs HEAD again, and do its live tracked stats still
// count more than that last-commit baseline. A mismatch -- clean content, but inflated live
// stats -- can only mean uncommitted tracked work was just thrown away, so the live stats roll
// back to EXACTLY the baseline (an overwrite, not a subtraction): whatever was already part of
// a previous commit on this branch is real history and stays counted, only the discarded
// uncommitted portion is erased. Called on a debounce after .git/index.lock settles (see
// startGitOperationWatcher) -- covers discards made via `git checkout`/`git restore`, the
// Source Control view's "Discard Changes", and a stash pop that lands a file back at exactly
// its last-commit content.
//
// Skips any file with no per-file baseline in commit-snapshot.json: an old-format snapshot
// (written before this feature existed) has no `files` breakdown at all, and a file that has
// never been part of a commit on this branch has no baseline to roll back to -- in both cases
// skipping is the safe choice, since rolling back to a guessed or missing baseline would
// wrongly zero out real, legitimate history. This self-heals: the very next commit on the
// branch writes a fresh, complete per-file baseline via cmdPostCommit().
function reconcileDiscardedFiles(repoRoot: string): number {
  const branch = getCurrentBranchCached(repoRoot);
  const snapshot = readJsonFile<CommitSnapshot>(getCommitSnapshotPath(repoRoot, branch));
  const baselineFiles = snapshot?.files;
  if (!baselineFiles) {
    debugLog("reconcileDiscardedFiles: no per-file baseline in commit-snapshot.json yet (old-format snapshot, or no commits on this branch): skipping");
    return 0;
  }

  let changedCount = 0;
  for (const [relativePath, baseline] of Object.entries(baselineFiles)) {
    const live = charStats.get(relativePath);
    if (!live) continue; // nothing tracked live for this file right now -- nothing to reconcile
    if (sumCharCounts(live) <= sumCharCounts(baseline)) continue; // already at or below baseline

    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue; // missing-file exclusion (computeAggregate) already handles this

    let isCleanVsHead: boolean;
    try {
      execFileSync("git", ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", relativePath], { stdio: "ignore" });
      isCleanVsHead = true;
    } catch {
      // git diff --quiet exits 1 (throws here) when there IS a difference -- that's the
      // expected, common case (uncommitted work still in progress), not an error.
      isCleanVsHead = false;
    }
    if (!isCleanVsHead) continue;

    debugLog(
      `reconcileDiscardedFiles: "${relativePath}" is clean vs HEAD but live stats (${sumCharCounts(live)}) exceed its last-commit baseline (${sumCharCounts(baseline)}) -- rolling back to baseline (uncommitted changes were discarded)`
    );
    charStats.set(relativePath, {
      manual: baseline.manual,
      byProvider: { ...baseline.byProvider },
      unknown: baseline.unknown,
      lastModified: new Date().toISOString(),
    });
    changedCount += 1;
  }

  if (changedCount > 0) {
    scheduleCharStatsPersist(repoRoot, branch);
    renderStatsStatusBar();
    statsTreeProvider.refresh();
  }

  return changedCount;
}

// User-triggered counterpart to the automatic reconcileDiscardedFiles() call in
// startGitOperationWatcher: that one only runs on a debounce after a commit/merge/rebase/checkout
// touches .git/index.lock, so there's no way to ask for a recalculation on demand (e.g. after a
// Source Control discard the watcher happened to miss, or just to confirm the numbers are still
// trustworthy). Same underlying logic, just callable directly from the sidebar's "Recalculate
// Stats" button and reporting back what it found via a status message.
function recalculateStatsFromGit() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a workspace folder inside a git repo to recalculate attribution stats.");
    return;
  }
  const changedCount = reconcileDiscardedFiles(repoRoot);
  if (changedCount > 0) {
    vscode.window.showInformationMessage(
      `Recalculated attribution stats: rolled back ${changedCount} file(s) whose uncommitted changes had been discarded.`
    );
  } else {
    vscode.window.showInformationMessage("Recalculated attribution stats: everything already matches the tracked data.");
  }
}

function getLegacyCharStatsPath(repoRoot: string): string {
  return path.join(getCachedGitDir(repoRoot), "ai-attribution-stats.json");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// Upgrades a possibly-legacy (v1, no provider breakdown) char-stats file to the current v2
// shape. v1 files fold their "ai" + "paste" counts into "unknown" rather than guessing which
// provider they belonged to -- we were never told, so we don't pretend to know.
function upgradeCharStatsState(raw: unknown): CharStatsState | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as { version?: number; files?: Record<string, unknown> };
  if (!state.files) return null;

  if (state.version === 2) {
    return raw as CharStatsState;
  }

  const files: Record<string, FileCharStats> = {};
  for (const [file, value] of Object.entries(state.files)) {
    const legacy = (value ?? {}) as Partial<LegacyFileCharStatsV1>;
    files[file] = {
      manual: legacy.manual ?? 0,
      byProvider: {},
      unknown: (legacy.ai ?? 0) + (legacy.paste ?? 0),
      lastModified: legacy.lastModified ?? "",
    };
  }
  return { version: 2, files };
}

// One-time migration: character stats used to be tracked repo-wide with no branch dimension
// (.git/ai-attribution-stats.json). Move any existing data into a clearly-labeled "legacy"
// bucket instead of silently discarding it or misattributing it to whichever branch happens
// to be checked out at migration time. The old file is renamed (never deleted) so nothing is lost.
function migrateLegacyCharStatsIfNeeded(repoRoot: string) {
  const legacyPath = getLegacyCharStatsPath(repoRoot);
  if (!fs.existsSync(legacyPath)) return;

  const newPath = getCharStatsPath(repoRoot, LEGACY_BRANCH_DIR);
  if (!fs.existsSync(newPath)) {
    try {
      const legacy = readJsonFile<unknown>(legacyPath);
      if (legacy) {
        ensureParentDir(newPath);
        fs.writeFileSync(newPath, JSON.stringify(legacy, null, 2) + "\n", "utf8");
      }
    } catch {
      return; // leave the legacy file alone if migration fails -- nothing lost, we'll retry next activation
    }
  }

  try {
    fs.renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // non-fatal -- worst case migration is attempted again (and no-ops) next activation
  }
}

function writeState(repoRoot: string, branch: string, provider: Provider, changedFile?: string) {
  const statePath = getStatePath(repoRoot, branch);
  const existing = readJsonFile<AttributionState>(statePath);

  const existingByProvider = existing?.filesByProvider ?? {};
  const providerFiles = unique([...(existingByProvider[provider] ?? []), ...(changedFile ? [changedFile] : [])]);

  const next: AttributionState = {
    branch,
    filesByProvider: { ...existingByProvider, [provider]: providerFiles },
    updatedAt: new Date().toISOString(),
  };

  ensureParentDir(statePath);
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function clearState(repoRoot: string, branch: string) {
  const statePath = getStatePath(repoRoot, branch);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

function isSessionActive(): boolean {
  return !!activeSession && activeSession.expiresAt > Date.now();
}

function setActiveProvider(provider: Provider, reason: string) {
  activeSession = {
    provider,
    expiresAt: Date.now() + getSessionTtlMs(),
    reason,
  };
  activeProviderSetAt = Date.now();
  renderStatusBar();
}

function refreshSession(provider?: Provider) {
  if (!activeSession) return;
  activeSession.expiresAt = Date.now() + getSessionTtlMs();
  if (provider && provider !== activeSession.provider) {
    activeSession.provider = provider;
    activeProviderSetAt = Date.now();
  }
  renderStatusBar();
}

function clearActiveSession() {
  activeSession = null;
  renderStatusBar();
}

function renderStatusBar() {
  if (!activeSession || activeSession.expiresAt <= Date.now()) {
    activeSession = null;
    statusBar.text = "$(circle-outline) AI Attr: Off";
    statusBar.tooltip = "AI commit attribution is idle";
    return;
  }

  const seconds = Math.max(0, Math.floor((activeSession.expiresAt - Date.now()) / 1000));
  statusBar.text = `$(circle-filled) AI Attr: ${activeSession.provider}`;
  statusBar.tooltip = `Tracking ${activeSession.provider} edits (${seconds}s remaining)\nReason: ${activeSession.reason}`;
}

// Loads the character stats for `branch` into the in-memory map, replacing whatever branch
// was previously loaded. Cheap no-op if that branch is already loaded, unless force is set
// (used after a reset, where the on-disk file has just been deleted).
function loadCharStatsForBranch(repoRoot: string, branch: string, force = false) {
  if (!force && statsLoadedForBranch === branch) return;
  charStats.clear();
  const raw = readJsonFile<unknown>(getCharStatsPath(repoRoot, branch));
  const state = upgradeCharStatsState(raw);
  if (state?.files) {
    for (const [file, stats] of Object.entries(state.files)) {
      charStats.set(file, stats);
    }
  }
  statsLoadedForBranch = branch;
}

function persistCharStatsNow(repoRoot: string, branch: string) {
  const state: CharStatsState = {
    version: 2,
    files: Object.fromEntries(charStats),
  };
  const statsPath = getCharStatsPath(repoRoot, branch);
  ensureParentDir(statsPath);
  fs.writeFileSync(statsPath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function scheduleCharStatsPersist(repoRoot: string, branch: string) {
  if (statsPersistTimer) clearTimeout(statsPersistTimer);
  statsPersistTimer = setTimeout(() => persistCharStatsNow(repoRoot, branch), STATS_PERSIST_DEBOUNCE_MS);
}

// Fires when .git/HEAD changes to a different branch: flushes any pending writes for the
// branch we're leaving (so nothing is lost to the debounce window), then swaps the in-memory
// stats over to the new branch and re-renders every view that reads from them.
function onBranchChanged(repoRoot: string, previousBranch: string | null, newBranch: string) {
  if (statsPersistTimer && previousBranch) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
    persistCharStatsNow(repoRoot, previousBranch);
  }
  loadCharStatsForBranch(repoRoot, newBranch);
  renderStatsStatusBar();
  statsTreeProvider.refresh();
  prState = "unknown";
  refreshActionsPanel();
  void refreshPrState(repoRoot);
}

// Attributes ai/paste characters to `provider` when known, "unknown" otherwise. Manual chars
// are always provider-agnostic.
function recordCharChange(relativePath: string, cls: CharClass, count: number, provider: Provider | null) {
  const existing = charStats.get(relativePath) ?? { manual: 0, byProvider: {}, unknown: 0, lastModified: "" };
  if (cls === "manual") {
    existing.manual += count;
  } else if (provider) {
    existing.byProvider[provider] = (existing.byProvider[provider] ?? 0) + count;
  } else {
    existing.unknown += count;
  }
  existing.lastModified = new Date().toISOString();
  charStats.set(relativePath, existing);
}

// Subtracts a previously recorded delta from the exact bucket recordCharChange put it in --
// mirrors its bucket selection in reverse. Clamped at 0 so this can never send a count negative
// (e.g. if a reset or file-level clear happened to land in between, however unlikely).
function reverseCharChange(relativePath: string, bucket: RecordedInsertion["bucket"], count: number) {
  const existing = charStats.get(relativePath);
  if (!existing) return;
  if (bucket.kind === "manual") {
    existing.manual = Math.max(0, existing.manual - count);
  } else if (bucket.kind === "provider") {
    existing.byProvider[bucket.provider] = Math.max(0, (existing.byProvider[bucket.provider] ?? 0) - count);
  } else {
    existing.unknown = Math.max(0, existing.unknown - count);
  }
  existing.lastModified = new Date().toISOString();
  charStats.set(relativePath, existing);
}

// Moves a previously recorded delta from one bucket to `toProvider`, WITHOUT changing the
// file's total -- a correction, not an undo. Exists for exactly one caller
// (reattributeRecentInsertionIfMisattributed): a claude-signal can arrive just AFTER the edit
// it describes was already recorded under the wrong bucket (auto-detect guessing "copilot"
// because the Copilot extension happens to be active, or no session being active yet so the
// edit landed in "unknown") -- this reattributes that specific edit's count once the signal
// supplies real evidence of who actually wrote it, rather than leaving it permanently wrong.
function reattributeCharChange(relativePath: string, fromBucket: RecordedInsertion["bucket"], toProvider: Provider, count: number) {
  const existing = charStats.get(relativePath);
  if (!existing) return;
  if (fromBucket.kind === "manual") {
    existing.manual = Math.max(0, existing.manual - count);
  } else if (fromBucket.kind === "provider") {
    existing.byProvider[fromBucket.provider] = Math.max(0, (existing.byProvider[fromBucket.provider] ?? 0) - count);
  } else {
    existing.unknown = Math.max(0, existing.unknown - count);
  }
  existing.byProvider[toProvider] = (existing.byProvider[toProvider] ?? 0) + count;
  existing.lastModified = new Date().toISOString();
  charStats.set(relativePath, existing);
}

// Called from handleSignal when a fresh claude-signal either starts a session or switches an
// active one: corrects the SPECIFIC edit that prompted the signal, if it was already recorded
// under the wrong bucket a moment before the signal arrived (see the callers' comments for
// why that race happens). Looks up lastInsertionByDocument's single most-recent-insertion
// slot for whichever open document matches signal's absolute path, and only acts if that
// insertion is BOTH recent enough to plausibly be the edit this signal describes (bounded by
// the same freshness window used to trust the signal itself) AND not already correctly
// attributed -- and never touches a genuinely manual edit, which this signal has no business
// reclassifying.
function reattributeRecentInsertionIfMisattributed(absoluteFile: string, correctProvider: Provider, repoRoot: string) {
  if (!absoluteFile) return;
  const matchedDocument = vscode.workspace.textDocuments.find(
    (doc) => path.resolve(doc.uri.fsPath) === path.resolve(absoluteFile)
  );
  if (!matchedDocument) return;

  const key = matchedDocument.uri.toString();
  const pending = lastInsertionByDocument.get(key);
  if (!pending) return;
  if (Date.now() - pending.recordedAt > CLAUDE_SIGNAL_FRESHNESS_WINDOW_MS) return;
  if (pending.bucket.kind === "manual") return; // never reclassify a genuinely manual edit
  if (pending.bucket.kind === "provider" && pending.bucket.provider === correctProvider) return; // already correct

  const fromLabel = pending.bucket.kind === "provider" ? pending.bucket.provider : "unknown";
  debugLog(
    `  -> reattributing the most recent insertion on "${pending.relativePath}" (${pending.count} chars) from "${fromLabel}" to "${correctProvider}" -- recorded just before this signal arrived and corrected the session`
  );
  reattributeCharChange(pending.relativePath, pending.bucket, correctProvider, pending.count);
  lastInsertionByDocument.set(key, { ...pending, bucket: { kind: "provider", provider: correctProvider } });

  const branch = getCurrentBranchCached(repoRoot);
  scheduleCharStatsPersist(repoRoot, branch);
  renderStatsStatusBar();
  statsTreeProvider.refresh();
}

// Structural sum shared by totalCharsFor (live FileCharStats) and reconcileDiscardedFiles
// (commit-snapshot per-file baselines, which have the same three counting fields but no
// lastModified) so both stay in exact agreement about what "total characters" means.
function sumCharCounts(stats: { manual: number; byProvider: ProviderCharCounts; unknown: number }): number {
  return stats.manual + stats.unknown + Object.values(stats.byProvider).reduce((sum: number, n) => sum + (n ?? 0), 0);
}

function totalCharsFor(stats: FileCharStats): number {
  return sumCharCounts(stats);
}

function computeAggregate(): { manual: number; byProvider: ProviderCharCounts; unknown: number; total: number } {
  const repoRoot = getRepoRoot();
  let manual = 0;
  let unknown = 0;
  const byProvider: ProviderCharCounts = {};
  for (const [relativePath, stats] of charStats.entries()) {
    // A file that doesn't exist on disk right now -- deleted, or currently stashed away --
    // shouldn't count toward "how much of this branch is AI-written". Its record in
    // char-stats.json is left untouched, so if the file comes back (a stash pop, undoing a
    // delete, switching to a branch that still has it) it counts again automatically; while
    // it's gone, it's excluded instead of silently inflating the total forever.
    if (repoRoot && !fs.existsSync(path.join(repoRoot, relativePath))) continue;
    manual += stats.manual;
    unknown += stats.unknown;
    for (const [provider, count] of Object.entries(stats.byProvider)) {
      byProvider[provider as Provider] = (byProvider[provider as Provider] ?? 0) + (count ?? 0);
    }
  }
  const providerTotal = Object.values(byProvider).reduce((sum: number, n) => sum + (n ?? 0), 0);
  return { manual, byProvider, unknown, total: manual + providerTotal + unknown };
}

function providerLabel(provider: Provider): string {
  return findProviderConfig(provider)?.label ?? provider;
}

function getDisplayBranchLabel(): string {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return "no repo";
  return getCurrentBranchCached(repoRoot);
}

function renderStatsStatusBar() {
  const { manual, byProvider, unknown, total } = computeAggregate();
  const branchLabel = getDisplayBranchLabel();
  if (total === 0) {
    statsStatusBar.text = "$(edit) Manual — | $(sparkle) AI —";
    statsStatusBar.tooltip = `No character attribution recorded yet for branch "${branchLabel}"`;
    refreshActionsPanel();
    return;
  }

  const aiTotal = unknown + Object.values(byProvider).reduce((sum: number, n) => sum + (n ?? 0), 0);
  const manualPct = ((manual / total) * 100).toFixed(0);
  const aiPct = ((aiTotal / total) * 100).toFixed(0);

  const breakdown = (["claude", "copilot"] as Provider[])
    .map((p) => ({ p, count: byProvider[p] ?? 0 }))
    .filter((x) => x.count > 0)
    .map((x) => `${providerLabel(x.p)} ${((x.count / total) * 100).toFixed(0)}%`);
  if (unknown > 0) breakdown.push(`unclear ${((unknown / total) * 100).toFixed(0)}%`);

  statsStatusBar.text =
    breakdown.length > 0
      ? `$(edit) Manual ${manualPct}% | $(sparkle) AI ${aiPct}% (${breakdown.join(" · ")})`
      : `$(edit) Manual ${manualPct}% | $(sparkle) AI ${aiPct}%`;

  statsStatusBar.tooltip = [
    `Branch: ${branchLabel}`,
    `Manual: ${manual}`,
    `Claude: ${byProvider.claude ?? 0}`,
    `Copilot: ${byProvider.copilot ?? 0}`,
    `AI, provider unclear (no active session at the time): ${unknown}`,
    `Total: ${total}`,
    "",
    'Run "AI Co-Authoring Tracker: Show Branch Report" to compare across branches.',
  ].join("\n");

  refreshActionsPanel();
}

function trackCharacterStats(
  event: vscode.TextDocumentChangeEvent,
  immediateUndoMatches: Set<vscode.TextDocumentContentChangeEvent>
) {
  if (!isCharacterStatsEnabled()) return;
  const document = event.document;
  if (!shouldTrackDocument(document)) return;
  if (isWithinGitOperationQuietWindow()) return; // handleTextDocumentChangeEvent already logged this

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  const relativePath = getRelativeWorkspacePath(document.uri);
  if (!relativePath) return;

  const branch = getCurrentBranchCached(repoRoot);
  loadCharStatsForBranch(repoRoot, branch);

  const key = document.uri.toString();
  const now = Date.now();
  const deltaMs = now - (lastEditAt.get(key) ?? now);
  lastEditAt.set(key, now);

  // If a session is active right now -- including one just auto-started by this same edit,
  // since handleTextDocumentChangeEvent runs before this in the same event handler -- ai/paste
  // characters get attributed to it. Otherwise we genuinely don't know which provider was
  // responsible (e.g. a quick inline completion accepted with no session running), so they
  // land in the honestly-labeled "unknown" bucket instead of a guess.
  const provider = isSessionActive() ? activeSession!.provider : null;
  debugLog(`trackCharacterStats: sessionActive=${isSessionActive()} provider=${provider ?? "null (will land in unknown/unclear)"} deltaMs=${deltaMs}`);

  let changed = false;
  for (const change of event.contentChanges) {
    if (immediateUndoMatches.has(change)) {
      // This deletion exactly undoes the most recent tracked insertion on this document --
      // reverse the count it added instead of leaving it permanently attributed (the default
      // for every other deletion, which we genuinely can't attribute back to a bucket).
      const pending = lastInsertionByDocument.get(key);
      if (pending) {
        reverseCharChange(pending.relativePath, pending.bucket, pending.count);
        lastInsertionByDocument.delete(key);
        changed = true;
      }
      continue;
    }

    const cls = classifyContentChange(change, deltaMs);
    if (!cls) continue;
    debugLog(`  charStats: classified "${cls}" (${change.text.length} chars) -> bucket=${provider ?? "unknown"}`);
    recordCharChange(relativePath, cls, change.text.length, provider);
    lastInsertionByDocument.set(key, {
      relativePath,
      bucket: cls === "manual" ? { kind: "manual" } : provider ? { kind: "provider", provider } : { kind: "unknown" },
      count: change.text.length,
      rangeOffset: change.rangeOffset,
      recordedAt: now,
    });
    changed = true;
  }

  if (!changed) return;

  scheduleCharStatsPersist(repoRoot, branch);
  renderStatsStatusBar();
  statsTreeProvider.refresh();
}

type AiStatsNode =
  | { kind: "summary" }
  | { kind: "file"; file: string; stats: FileCharStats };

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// The static shell (layout, buttons, styling) is set once per resolve; live numbers travel
// separately via postMessage (see AiCoauthoringTrackerPanelProvider.postSummary) so typing doesn't
// re-render the whole webview on every keystroke-shaped edit.
function getActionsPanelHtml(nonce: string, webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicon", "codicon.css"));
  const providers = getConfiguredProviders();
  const providerSegmentsHtml = providers
    .map((p) => `<span class="seg-provider" id="seg-${escapeHtml(p.id)}" style="background:${escapeHtml(p.color)}"></span>`)
    .join("");
  const providerTilesHtml = providers
    .map(
      (p) => `      <div class="stat-tile">
        <div class="stat-tile-head"><span class="swatch" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.label)}</div>
        <div class="stat-value" id="pct-${escapeHtml(p.id)}">—</div>
      </div>`
    )
    .join("\n");
  const providerIdsJson = JSON.stringify(providers.map((p) => p.id));
  const activeProviderId = isSessionActive() && activeSession ? activeSession.provider : undefined;
  const providerRadiosHtml = providers
    .map((p) => {
      const checked = activeProviderId ? p.id === activeProviderId : p.id === providers[0]?.id;
      return `      <label class="provider-radio"><input type="radio" name="provider" value="${escapeHtml(
        p.id
      )}"${checked ? " checked" : ""}><span class="provider-swatch" style="background:${escapeHtml(
        p.color
      )}"></span>${escapeHtml(p.label)}</label>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconUri}">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground);
    padding: 12px 12px 22px;
  }

  /* Summary card -- pinned, never collapses, so current-branch data is always visible. */
  .summary-card {
    background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.06));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 12px 14px 14px;
    margin-bottom: 18px;
  }
  .branch-eyebrow {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }
  .branch-name {
    font-weight: 600;
    font-size: 1.02em;
    overflow-wrap: anywhere;
    margin-bottom: 12px;
  }
  .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--vscode-panel-border); margin-bottom: 12px; }
  .bar span { height: 100%; width: 0%; transition: width 200ms ease; }
  /* Manual and Unclear are always exactly these two fixed colors -- everything else is a
     configured provider, colored inline per aiCoauthoringTracker.providers rather than by CSS class,
     since the set of providers (and their colors) isn't known until this page is built. */
  .seg-manual { background: var(--vscode-charts-blue); }
  .seg-unclear { background: var(--vscode-descriptionForeground); opacity: 0.55; }

  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
  .stat-tile {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 7px 9px;
  }
  .stat-tile-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
  }
  .stat-value { font-size: 1.05em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; flex-shrink: 0; }
  .swatch-manual { background: var(--vscode-charts-blue); }
  .swatch-unclear { background: var(--vscode-descriptionForeground); opacity: 0.55; }
  .total-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }

  /* One radio per configured provider -- picking one and pressing the play button below is how
     a session is (re)started, instead of a separate button per provider (which doesn't scale
     past two) or a quick-pick dialog (which hides the current choice). */
  .provider-picker { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 4px; }
  .provider-radio {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 0.85em;
    cursor: pointer;
  }
  .provider-radio:hover { background: var(--vscode-list-hoverBackground); }
  .provider-radio input[type="radio"] { margin: 0; accent-color: var(--vscode-focusBorder); }
  .provider-swatch { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }

  /* Collapsible sections below the summary card -- deliberately minimal, matching how VS
     Code's own built-in views (Explorer, Timeline) label a collapsible group: a small
     uppercase caption and a chevron, no card chrome or border box around it. Per VS Code's
     own UX guidance ("use buttons only for primary actions", keep names short and avoid
     visual clutter -- code.visualstudio.com/api/ux-guidelines/views), everything below a
     header is a flat, hoverable row rather than a colored button. */
  details.accordion { margin-bottom: 2px; }
  details.accordion summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 6px;
    font-size: 0.78em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-sideBarTitle-foreground, var(--vscode-foreground)));
    display: flex;
    align-items: center;
    gap: 6px;
    user-select: none;
    border-radius: 4px;
  }
  details.accordion summary::-webkit-details-marker { display: none; }
  details.accordion summary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.08)); }
  details.accordion .chevron { display: inline-flex; transition: transform 120ms ease; color: var(--vscode-descriptionForeground); }
  details.accordion .chevron .codicon { font-size: 14px; }
  details.accordion[open] .chevron { transform: rotate(90deg); }
  details.accordion .accordion-body { padding: 2px 0 6px; display: flex; flex-direction: column; }
  details.accordion.danger summary { color: var(--vscode-errorForeground); }
  details.accordion.help .accordion-body { padding: 4px 6px 6px; }

  /* Every action is a full-width, icon-led row -- one per line, so a lone action in a
     section (e.g. "Reports") looks exactly like a paired one instead of stretching into an
     oversized pill. Flat by default; hover/active use the same list-highlight colors VS
     Code's own tree views use, so this reads as a native list rather than custom UI chrome. */
  .btn-row { display: flex; flex-direction: column; }
  button[data-command] {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 5px 6px;
    background: transparent;
    color: var(--vscode-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    font-family: var(--vscode-font-family, sans-serif);
  }
  button[hidden] { display: none !important; }
  button[data-command]:hover { background: var(--vscode-list-hoverBackground); }
  button[data-command]:active { background: var(--vscode-list-activeSelectionBackground); }
  button[data-command] .codicon {
    font-size: 15px;
    flex-shrink: 0;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
  }
  button[data-command].danger { color: var(--vscode-errorForeground); }
  button[data-command].danger .codicon { color: var(--vscode-errorForeground); }

  /* Session's one real primary action -- styled as an actual themed button (VS Code's own
     button tokens, so it automatically matches whatever accent color the user's theme uses)
     rather than a flat list row, since everything else in these sections is a secondary
     action and this is the one that actually does something you'd reach for first. */
  #btn-start-provider {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    width: 33%;
    align-self: flex-start;
    white-space: nowrap;
    padding: 3px 8px;
    margin: 4px 0 2px;
    background: var(--vscode-button-background, var(--vscode-focusBorder));
    color: var(--vscode-button-foreground, #ffffff);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    font-weight: 500;
    font-family: var(--vscode-font-family, sans-serif);
  }
  #btn-start-provider:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background, var(--vscode-focusBorder))); }
  #btn-start-provider:active { opacity: 0.85; }
  #btn-start-provider .codicon { font-size: 12px; flex-shrink: 0; }

  .workflow { margin: 4px 0 0; padding-left: 18px; font-size: 0.88em; line-height: 1.6; }
  .workflow li { margin-bottom: 6px; }
  .workflow li:last-child { margin-bottom: 0; }
  .help-note { font-size: 0.85em; color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 0 0 8px; }

  .footnote { font-size: 0.8em; color: var(--vscode-descriptionForeground); line-height: 1.5; margin-top: 14px; }
</style>
</head>
<body>
  <div class="summary-card">
    <div class="branch-eyebrow">Branch</div>
    <div class="branch-name" id="branch">—</div>
    <div class="bar">
      <span class="seg-manual" id="seg-manual"></span>${providerSegmentsHtml}<span class="seg-unclear" id="seg-unclear"></span>
    </div>
    <div class="stat-grid">
      <div class="stat-tile">
        <div class="stat-tile-head"><span class="swatch swatch-manual"></span>Manual</div>
        <div class="stat-value" id="pct-manual">—</div>
      </div>
${providerTilesHtml}
      <div class="stat-tile">
        <div class="stat-tile-head"><span class="swatch swatch-unclear"></span>Unclear</div>
        <div class="stat-value" id="pct-unclear">—</div>
      </div>
    </div>
    <div class="total-label" id="total">No data yet</div>
  </div>

  <details class="accordion" open>
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Current AI Provider</summary>
    <div class="accordion-body">
      <div class="provider-picker" role="radiogroup" aria-label="AI provider">
${providerRadiosHtml}
      </div>
      <div class="btn-row">
      <button id="btn-start-provider" title="Start or switch to the selected provider"><i class="codicon codicon-play"></i>Switch</button>
      <button data-command="aiCoauthoringTracker.clear"><i class="codicon codicon-circle-slash"></i>Clear session</button>
      </div>
    </div>
  </details>

  <details class="accordion">
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Stats</summary>
    <div class="accordion-body">
      <div class="btn-row">
      <button data-command="aiCoauthoringTracker.showStats"><i class="codicon codicon-output"></i>View stats log</button>
      <button data-command="aiCoauthoringTracker.refreshStats"><i class="codicon codicon-refresh"></i>Refresh display</button>
      <button data-command="aiCoauthoringTracker.recalculateStats"><i class="codicon codicon-sync"></i>Recalculate from git</button>
      <button class="danger" data-command="aiCoauthoringTracker.resetStats"><i class="codicon codicon-trash"></i>Delete stats for this file</button>
      </div>
    </div>
  </details>

  <details class="accordion">
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Reports</summary>
    <div class="accordion-body">
      <div class="btn-row">
      <button data-command="aiCoauthoringTracker.showBranchReport"><i class="codicon codicon-graph-line"></i>Open branch report</button>
      </div>
    </div>
  </details>

  <details class="accordion">
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Commit &amp; PR</summary>
    <div class="accordion-body">
      <div class="btn-row">
      <button data-command="aiCoauthoringTracker.previewCommitTrailer"><i class="codicon codicon-eye"></i>Preview commit trailer</button>
      <button data-command="aiCoauthoringTracker.previewPrSummary"><i class="codicon codicon-eye"></i>Preview PR summary</button>
      <button id="btn-create-pr" data-command="aiCoauthoringTracker.createPullRequest"><i class="codicon codicon-git-pull-request-create"></i>Create PR</button>
      <button id="btn-update-pr" data-command="aiCoauthoringTracker.updatePullRequest"><i class="codicon codicon-git-pull-request"></i>Update PR description</button>
      <button data-command="aiCoauthoringTracker.reinstallHooksForThisRepo"><i class="codicon codicon-sync"></i>Reinstall/update git hooks</button>
      <button data-command="aiCoauthoringTracker.listInstalledRepos"><i class="codicon codicon-list-unordered"></i>Repos with hooks installed</button>
      </div>
    </div>
  </details>

  <details class="accordion danger">
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Danger zone</summary>
    <div class="accordion-body">
      <div class="btn-row">
      <button class="danger" data-command="aiCoauthoringTracker.resetBranchStats"><i class="codicon codicon-trash"></i>Delete this branch’s data</button>
      <button class="danger" data-command="aiCoauthoringTracker.resetAllStats"><i class="codicon codicon-trash"></i>Delete all branches’ data</button>
      </div>
    </div>
  </details>

  <details class="accordion help">
    <summary><span class="chevron"><i class="codicon codicon-chevron-right"></i></span>Help</summary>
    <div class="accordion-body">
      <p class="help-note">Manual vs. AI character tracking, per branch, entirely local -- see the extension's README for full details on what each number means.</p>
      <p class="help-note" style="margin-bottom: 4px;"><strong>A typical workflow:</strong></p>
      <ol class="workflow">
        <li>Start coding. Auto-detect picks up large AI-applied edits on its own -- or start a session manually from the Session section above if you want every keystroke attributed to a specific provider.</li>
        <li>Keep an eye on the summary card at the top -- it updates live as you type, no need to run anything.</li>
        <li>Commit as normal. An <code>AI-Coauthoring:</code> trailer is added to the commit message automatically, once hooks are installed.</li>
        <li>Opening a PR? Run <strong>Preview PR summary</strong> first to check the numbers, then <strong>Create PR</strong> (or <strong>Update PR description</strong> once a PR exists) when you're happy with it. After that, pushing the branch refreshes the PR description automatically.</li>
        <li>Comparing work across branches? <strong>Open branch report</strong> lays every branch side by side.</li>
      </ol>
      <p class="help-note" style="margin: 10px 0 4px;"><strong>Attribution looking wrong?</strong> Turn this on, reproduce the edit, then check the "AI Co-Authoring Tracker Debug" output channel for exactly what was seen and why.</p>
      <p class="help-note" style="margin: 10px 0 4px;"><strong>Claude Code edits not detected precisely?</strong> A one-time, global hook tells this extension exactly which file Claude Code just touched -- installed automatically on first use, but you can (re)install or resync it here.</p>
      <div class="btn-row">
      <button data-command="aiCoauthoringTracker.toggleDebugLogging"><i class="codicon codicon-bug"></i>Toggle debug logging</button>
      <button data-command="aiCoauthoringTracker.installClaudeSignalHook"><i class="codicon codicon-plug"></i>Install Claude Code hook</button>
      </div>
    </div>
  </details>

  <p class="footnote">Local, per-branch attribution data. Nothing here is committed or shared.</p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // The set of provider ids this page was built with -- baked in server-side from
  // aiCoauthoringTracker.providers at render time, so applyUpdate() can find each provider's
  // pct-<id>/seg-<id> elements without hardcoding which providers exist.
  const PROVIDER_IDS = ${providerIdsJson};

  document.querySelectorAll("button[data-command]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      vscode.postMessage({ type: "runCommand", command: btn.getAttribute("data-command") });
    });
  });

  const startProviderBtn = document.getElementById("btn-start-provider");
  if (startProviderBtn) {
    startProviderBtn.addEventListener("click", function () {
      const selected = document.querySelector('input[name="provider"]:checked');
      vscode.postMessage({
        type: "runCommand",
        command: "aiCoauthoringTracker.startProvider",
        args: selected ? [selected.value] : [],
      });
    });
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "prState") {
      // Unknown (gh not checked yet / unavailable): show both, so nothing is hidden by a failed check.
      const createBtn = document.getElementById("btn-create-pr");
      const updateBtn = document.getElementById("btn-update-pr");
      if (createBtn) createBtn.hidden = msg.state === "open";
      if (updateBtn) updateBtn.hidden = msg.state === "none";
      return;
    }
    if (msg.type !== "update") return;
    applyUpdate(msg.payload);
  });

  function applyUpdate(p) {
    const total = p.total;

    document.getElementById("branch").textContent = p.branch;

    function pct(n) {
      return total === 0 ? "—" : ((n / total) * 100).toFixed(1) + "%";
    }
    document.getElementById("pct-manual").textContent = pct(p.manual);
    for (const id of PROVIDER_IDS) {
      const el = document.getElementById("pct-" + id);
      if (el) el.textContent = pct((p.byProvider && p.byProvider[id]) || 0);
    }
    document.getElementById("pct-unclear").textContent = pct(p.unknown);

    document.getElementById("total").textContent =
      total === 0 ? "No data yet on this branch" : total.toLocaleString() + " characters tracked";

    const segs = [["seg-manual", p.manual]];
    for (const id of PROVIDER_IDS) {
      segs.push(["seg-" + id, (p.byProvider && p.byProvider[id]) || 0]);
    }
    segs.push(["seg-unclear", p.unknown]);
    for (let i = 0; i < segs.length; i++) {
      const id = segs[i][0];
      const count = segs[i][1];
      const el = document.getElementById(id);
      if (el) el.style.width = total === 0 ? "0%" : (count / total) * 100 + "%";
    }
  }

  // The extension may call postMessage() the instant this webview is (re)created -- before this
  // script has finished parsing and this listener is attached, which silently drops that first
  // update and leaves the static placeholder dashes on screen forever (most visible after
  // switching away to another view, e.g. Source Control to run a git command, and back: the
  // webview can be torn down and recreated, racing a fresh update against a fresh page load).
  // Telling the extension once this listener is actually live, and having it (re)send the
  // current numbers in response, closes that race regardless of why the page reloaded.
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

// Sidebar Activity Bar panel: every command as a one-click button, plus a live summary of the
// current branch's manual/Claude/Copilot/unclear split (the same numbers the status bar shows).
// The static HTML is set once on resolve; after that, only postSummary() runs, pushing fresh
// numbers into the already-loaded page rather than re-rendering it.
class AiCoauthoringTrackerPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiCoauthoringTrackerActionsPanel";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = getActionsPanelHtml(getNonce(), webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage((message: { type?: string; command?: string; args?: unknown[] }) => {
      if (message?.type === "ready") {
        // Belt-and-suspenders for the same race retainContextWhenHidden mostly avoids: this page
        // only just finished attaching its message listener, so THIS is the first moment a
        // postMessage is guaranteed to land rather than be silently dropped.
        this.postSummary();
        this.postPrState();
        return;
      }
      if (
        message?.type === "runCommand" &&
        typeof message.command === "string" &&
        message.command.startsWith("aiCoauthoringTracker.")
      ) {
        const args = Array.isArray(message.args) ? message.args : [];
        void vscode.commands.executeCommand(message.command, ...args);
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });

    this.postSummary();
  }

  postPrState() {
    void this.view?.webview.postMessage({ type: "prState", state: prState });
  }

  postSummary() {
    if (!this.view) return;
    const { manual, byProvider, unknown, total } = computeAggregate();
    void this.view.webview.postMessage({
      type: "update",
      payload: {
        branch: getDisplayBranchLabel(),
        manual,
        byProvider,
        unknown,
        total,
      },
    });
  }
}

let actionsPanelProvider: AiCoauthoringTrackerPanelProvider | undefined;

function refreshActionsPanel() {
  actionsPanelProvider?.postSummary();
  actionsPanelProvider?.postPrState();
}

class AiStatsTreeDataProvider implements vscode.TreeDataProvider<AiStatsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AiStatsNode): vscode.TreeItem {
    if (element.kind === "summary") {
      const { manual, byProvider, unknown, total } = computeAggregate();
      const branchLabel = getDisplayBranchLabel();
      const item = new vscode.TreeItem(`Branch Total (${branchLabel})`, vscode.TreeItemCollapsibleState.None);
      item.description = total === 0 ? "no data" : `${total} chars`;
      item.tooltip = [
        `Branch: ${branchLabel}`,
        `Manual: ${manual}`,
        `Claude: ${byProvider.claude ?? 0}`,
        `Copilot: ${byProvider.copilot ?? 0}`,
        `Unclear provider: ${unknown}`,
        `Total: ${total}`,
      ].join("\n");
      return item;
    }

    const { file, stats } = element;
    const total = totalCharsFor(stats);
    const manualPct = total === 0 ? 0 : Math.round((stats.manual / total) * 100);
    const aiPct = total === 0 ? 0 : 100 - manualPct;
    const repoRootForItem = getRepoRoot();
    const missing = repoRootForItem && !fs.existsSync(path.join(repoRootForItem, file));
    const item = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
    item.description = `${total} chars (${manualPct}% manual / ${aiPct}% AI)${missing ? " -- missing on disk" : ""}`;
    item.tooltip = [
      `Manual: ${stats.manual}`,
      `Claude: ${stats.byProvider.claude ?? 0}`,
      `Copilot: ${stats.byProvider.copilot ?? 0}`,
      `Unclear provider: ${stats.unknown}`,
      `Last modified: ${stats.lastModified}`,
    ].join("\n");
    item.resourceUri = vscode.Uri.file(file);
    return item;
  }

  getChildren(element?: AiStatsNode): AiStatsNode[] {
    if (element) return [];
    const fileNodes: AiStatsNode[] = [...charStats.entries()]
      .sort(([, a], [, b]) => totalCharsFor(b) - totalCharsFor(a))
      .map(([file, stats]) => ({ kind: "file" as const, file, stats }));
    return [{ kind: "summary" }, ...fileNodes];
  }
}

function showCharStatsDebugInfo() {
  const { manual, byProvider, unknown, total } = computeAggregate();
  const branchLabel = getDisplayBranchLabel();
  statsOutputChannel.clear();
  statsOutputChannel.appendLine(`AI Co-Authoring Tracker — Character Attribution Stats (branch: ${branchLabel})`);
  statsOutputChannel.appendLine(
    `Total: ${total} | Manual: ${manual} | Claude: ${byProvider.claude ?? 0} | Copilot: ${byProvider.copilot ?? 0} | Unclear: ${unknown}`
  );
  statsOutputChannel.appendLine("");
  const repoRootForDebug = getRepoRoot();
  for (const [file, stats] of charStats.entries()) {
    const missing = repoRootForDebug && !fs.existsSync(path.join(repoRootForDebug, file));
    statsOutputChannel.appendLine(
      `${file}${missing ? " (missing on disk -- excluded from totals above)" : ""}: manual=${stats.manual} claude=${stats.byProvider.claude ?? 0} copilot=${stats.byProvider.copilot ?? 0} unclear=${stats.unknown} (updated ${stats.lastModified})`
    );
  }
  statsOutputChannel.show(true);
}

async function resetCharStatsForActiveFile() {
  const repoRoot = getRepoRoot();
  const document = vscode.window.activeTextEditor?.document;
  if (!repoRoot || !document) {
    vscode.window.showInformationMessage("Open a file to reset its attribution stats.");
    return;
  }
  const relativePath = getRelativeWorkspacePath(document.uri);
  if (!relativePath) return;

  debugLog(`resetStats requested for "${relativePath}" -- asking for confirmation before deleting its tracked stats`);

  const confirmation = await vscode.window.showWarningMessage(
    `Reset attribution stats for "${relativePath}"? This deletes its manual/Claude/Copilot character counts and cannot be undone.`,
    { modal: true },
    "Reset This File"
  );
  if (confirmation !== "Reset This File") {
    debugLog(`resetStats for "${relativePath}" cancelled -- no changes made`);
    return;
  }

  charStats.delete(relativePath);
  scheduleCharStatsPersist(repoRoot, getCurrentBranchCached(repoRoot));
  renderStatsStatusBar();
  statsTreeProvider.refresh();
  debugLog(`resetStats: cleared tracked stats for "${relativePath}"`);
  vscode.window.showInformationMessage(`Reset attribution stats for ${relativePath}.`);
}

function getRelativeWorkspacePath(uri: vscode.Uri): string | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const fullPath = uri.fsPath;
  if (!fullPath.startsWith(repoRoot)) return null;

  return path.relative(repoRoot, fullPath).replace(/\\/g, "/");
}

function shouldTrackDocument(document: vscode.TextDocument): boolean {
  if (document.isUntitled) return false;
  if (document.uri.scheme !== "file") return false;
  return true;
}

function maybeTrackDocumentChange(document: vscode.TextDocument) {
  if (!isSessionActive() || !activeSession) return;
  if (!shouldTrackDocument(document)) return;
  if (isWithinGitOperationQuietWindow()) return;

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  const relativePath = getRelativeWorkspacePath(document.uri);
  if (!relativePath) return;

  writeState(repoRoot, getCurrentBranchCached(repoRoot), activeSession.provider, relativePath);
  refreshSession();
}

// AI-shaped edits (large atomic multi-line changes, e.g. a "Keep"/apply action) always update attribution,
// regardless of the current session status — they start a session if one isn't already running.
function handleTextDocumentChangeEvent(
  event: vscode.TextDocumentChangeEvent,
  immediateUndoMatches: Set<vscode.TextDocumentContentChangeEvent>
) {
  const document = event.document;
  if (!shouldTrackDocument(document)) return;

  if (isWithinGitOperationQuietWindow()) {
    debugLog(`change on ${document.uri.fsPath.split("/").pop()}: ignored -- inside git-operation quiet window, not a real edit`);
    return;
  }

  if (isDebugLoggingEnabled()) {
    const shapes = event.contentChanges
      .map((c) => `{chars=${c.text.length}, lines=${c.text.split("\n").length - 1}, rangeLength=${c.rangeLength}, ignored=${immediateUndoMatches.has(c)}}`)
      .join(" ");
    debugLog(`change on ${document.uri.fsPath.split("/").pop()}: ${shapes}`);
  }

  if (!looksLikeAiEdit(event, immediateUndoMatches)) {
    if (isSessionActive()) maybeTrackDocumentChange(document);
    else debugLog("  -> below AI-shape threshold, no session active: lands in \"unclear\" via trackCharacterStats, not tracked here");
    return;
  }

  debugLog(`  -> looks AI-shaped. autoDetectEnabled=${isAutoDetectEnabled()} sessionActive=${isSessionActive()} copilotExtensions=[${describeCopilotExtensions()}]`);

  if (!isAutoDetectEnabled() && !isSessionActive()) {
    debugLog("  -> autoDetect is OFF and no session active: ignoring (enable aiCoauthoringTracker.autoDetect, or start a session manually)");
    return;
  }

  if (isAutoDetectEnabled()) {
    if (!isSessionActive()) {
      // No session running yet -- there's no existing choice to respect, so the coarse
      // "is Copilot's extension active" guess is the best information available.
      const provider = guessProviderForAutoDetection();
      debugLog(`  -> auto-detected fresh session as "${provider}"`);
      setActiveProvider(provider, "auto-detected: large atomic edit");
      vscode.window.setStatusBarMessage(`AI Co-Authoring Tracker: auto-detected ${provider} edit`, 4000);
    } else if (isSessionProtectedFromReguess()) {
      // A manual choice, or a plain shape-guessed session, or a claude-signal-backed session
      // whose evidence is still fresh -- see isSessionProtectedFromReguess for why each of
      // those must never be overridden by this coarse size/shape heuristic. Only the TTL
      // extends; the provider stays exactly what it was.
      debugLog(
        `  -> session already active as "${activeSession?.provider}" (protected: reason="${activeSession?.reason}"): extending TTL only, not re-guessing`
      );
      refreshSession();
    } else {
      // The active session came from a claude-signal whose evidence has now gone stale (see
      // CLAUDE_SIGNAL_SESSION_PROTECTION_MS) -- it's no longer safe to assume it still
      // describes what's happening right now, so it's fair game for the shape heuristic to
      // re-guess this edit, the same way it would for a brand-new session.
      const guessed = guessProviderForAutoDetection();
      if (guessed !== activeSession!.provider) {
        debugLog(
          `  -> claude-signal evidence for the active session has gone stale: re-guessing as "${guessed}" (was "${activeSession!.provider}")`
        );
      } else {
        debugLog(`  -> claude-signal evidence stale, but re-guess still says "${guessed}": extending TTL only`);
      }
      refreshSession(guessed);
    }
  }

  maybeTrackDocumentChange(document);
}

type ClaudeSignal = {
  provider: Provider;
  file: string;
  cwd: string;
  updatedAt: string;
};

function startClaudeSignalWatcher(repoRoot: string) {
  if (claudeSignalWatcher) return;

  let signalPath: string;
  try {
    const gitDir = runGit(repoRoot, ["rev-parse", "--git-dir"]);
    signalPath = path.join(
      path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir),
      "claude-signal"
    );
  } catch {
    return;
  }

  const handleSignal = () => {
    const signal = readJsonFile<ClaudeSignal>(signalPath);
    if (!signal) return;

    const provider: Provider = signal.provider === "copilot" ? "copilot" : "claude";

    // signal.file is an absolute path -- in practice (confirmed via debug logging against a real
    // Claude Code CLI session) it names the exact file Claude Code just touched, arriving within
    // tens of milliseconds of the corresponding onDidChangeTextDocument event for that same file.
    // That is specific, real evidence about what just happened, not just "Claude Code did
    // something somewhere in this repo" -- so when it names a file VS Code actually has open,
    // it's trusted even over an already-active session. Matched against every open document, not
    // just the focused tab, since the edited file may not be the active editor (e.g. focus is in
    // the integrated terminal running `claude`).
    const matchesOpenDocument =
      !!signal.file &&
      vscode.workspace.textDocuments.some((doc) => path.resolve(doc.uri.fsPath) === path.resolve(signal.file!));

    // fs.watch on a busy .git directory can re-fire for "claude-signal" without the file's own
    // content actually changing (directory-level noise from unrelated git/index activity), and
    // separately the same underlying write can be delivered more than once. signal.updatedAt is
    // this write's own timestamp, so: (a) a signal old enough to be leftover/replayed noise is
    // ignored outright, and (b) a signal that predates the *current* session's provider (e.g. the
    // user ran "Start Copilot Attribution" after Claude last touched this file, and only then did
    // a delayed/duplicate delivery of that earlier write arrive) must not undo that newer,
    // explicit choice -- only a signal that's genuinely newer than it may switch the provider.
    const signalUpdatedAtMs = signal.updatedAt ? Date.parse(signal.updatedAt) : NaN;
    const signalAgeMs = Date.now() - signalUpdatedAtMs;
    const isFresh = Number.isFinite(signalAgeMs) && signalAgeMs < CLAUDE_SIGNAL_FRESHNESS_WINDOW_MS && signalAgeMs > -2000;
    const isNewerThanActiveSession = Number.isFinite(signalUpdatedAtMs) && signalUpdatedAtMs > activeProviderSetAt;

    debugLog(
      `claude-signal fired: provider=${provider} file=${signal.file || "(none)"} updatedAt=${signal.updatedAt || "(none)"} ageMs=${Number.isFinite(signalAgeMs) ? Math.round(signalAgeMs) : "n/a"} isFresh=${isFresh} sessionActive=${isSessionActive()} matchesOpenDocument=${matchesOpenDocument} isNewerThanActiveSession=${isNewerThanActiveSession}`
    );

    if (!isFresh) {
      debugLog("  -> signal is stale (older than the freshness window, missing, or malformed updatedAt): ignoring entirely");
      return;
    }

    lastClaudeSignalAcceptedAt = Date.now();

    if (!isSessionActive()) {
      // A sub-threshold edit (too small to trip the shape heuristic) may already have landed
      // in "unknown" moments ago, before this signal arrived to say a session should exist at
      // all -- correct that specific edit's attribution now that we know who wrote it, not
      // just future edits.
      reattributeRecentInsertionIfMisattributed(signal.file, provider, repoRoot);
      setActiveProvider(provider, "claude-signal hook");
      vscode.window.setStatusBarMessage(`AI Co-Authoring Tracker: Claude Code detected`, 4000);
    } else if (matchesOpenDocument && isNewerThanActiveSession) {
      debugLog(`  -> signal names an open document and postdates the active session's provider: switching from "${activeSession?.provider}" to "${provider}"`);
      // The edit that prompted this signal may already have been recorded under the WRONG
      // provider a moment ago (auto-detect guessing from the shape heuristic runs synchronously
      // on the document-change event, which can beat this signal's own fs.watch callback) --
      // reattribute that specific edit's count, not just the session going forward.
      reattributeRecentInsertionIfMisattributed(signal.file, provider, repoRoot);
      refreshSession(provider);
    } else {
      const reason = !matchesOpenDocument
        ? "doesn't match an open document"
        : "predates the active session's provider (a manual switch or newer evidence happened since)";
      debugLog(`  -> session already active as "${activeSession?.provider}", signal ${reason}: extending TTL only`);
      refreshSession();
    }

    if (signal.file) {
      writeState(repoRoot, getCurrentBranchCached(repoRoot), activeSession?.provider ?? provider, signal.file);
    }
  };

  try {
    claudeSignalWatcher = fs.watch(path.dirname(signalPath), (_eventType: string, filename: string | null) => {
      if (filename === "claude-signal") handleSignal();
    });
  } catch {
    // git dir not watchable, silently skip
  }
}

function stopClaudeSignalWatcher() {
  claudeSignalWatcher?.close();
  claudeSignalWatcher = null;
}

function isHooksInstalled(repoRoot: string): boolean {
  try {
    const hooksPath = runGit(repoRoot, ["config", "--get", "core.hooksPath"]);
    return hooksPath === ".githooks";
  } catch {
    return false;
  }
}

// Looks for install-hooks.sh in the workspace repo first (so a repo can ship its own,
// version-pinned copy), falling back to the copy bundled inside this extension's own install
// directory -- without this fallback, hook installation would only ever work when someone
// happens to open THIS extension's own source repo as their workspace.
function findInstallHooksScript(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, "scripts", "ai-coauthoring-install", "install-hooks.sh"),
    extensionInstallPath ? path.join(extensionInstallPath, "scripts", "ai-coauthoring-install", "install-hooks.sh") : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// Hides .githooks/ from VS Code's own Explorer and search view. This is written to the
// user's GLOBAL settings ONLY -- never the workspace's .vscode/settings.json -- so it stays a
// personal preference on this one machine and is never pushed onto other contributors who open
// the same repo. Mirrors the same "global, not repo" rule install-hooks.sh applies to git's own
// ignore list (see the core.excludesFile block there). Merges into whatever the user already
// has set globally rather than clobbering it, and is safe to call repeatedly (no-ops once set).
async function addGlobalVsCodeExcludes() {
  const targets: Array<["files" | "search", string]> = [
    ["files", "exclude"],
    ["search", "exclude"],
  ];
  for (const [section, key] of targets) {
    try {
      const config = vscode.workspace.getConfiguration(section);
      const inspected = config.inspect<Record<string, boolean>>(key);
      const current: Record<string, boolean> = { ...(inspected?.globalValue ?? {}) };
      if (current[".githooks"] === true) continue; // already set, nothing to do
      current[".githooks"] = true;
      await config.update(key, current, vscode.ConfigurationTarget.Global);
    } catch (error) {
      statsOutputChannel.appendLine(
        `AI Co-Authoring Tracker: couldn't update global VS Code "${section}.${key}" setting to hide .githooks/: ${String(
          error
        )}`
      );
    }
  }
}

async function promptInstallHooks(context: vscode.ExtensionContext, repoRoot: string) {
  if (isHooksInstalled(repoRoot)) return;

  const scriptPath = findInstallHooksScript(repoRoot);
  if (!scriptPath) return; // neither this repo nor the extension itself ships the install script

  const selection = await vscode.window.showInformationMessage(
    "This repository has AI co-authoring hooks available. Install them for this clone?",
    "Install",
    "Later"
  );

  if (selection !== "Install") return;

  try {
    const output = execFileSync("bash", [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    vscode.window.showInformationMessage("AI co-authoring hooks installed for this clone.");
    if (output.trim()) {
      statsOutputChannel.appendLine(output.trim());
    }
    await addGlobalVsCodeExcludes();
    await recordRepoHooksInstalled(context, repoRoot);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? err.stderr.toString() : err.message) ?? String(error);
    vscode.window.showErrorMessage(`Failed to install AI co-authoring hooks: ${detail.trim()}`);
    statsOutputChannel.appendLine(`AI Co-Authoring Tracker: hook install failed:\n${detail.trim()}`);
    statsOutputChannel.show(true);
  }
}

// Which files install-hooks.sh copies into .githooks/, and from where under
// scripts/ai-coauthoring-install/ -- kept in sync with that script's own `cp` lines so this
// never silently drifts from what a fresh install actually lays down.
const REPO_HOOK_FILES_TO_SYNC: Array<[sourceRelPath: string, targetName: string]> = [
  [path.join("hooks", "prepare-commit-msg"), "prepare-commit-msg"],
  [path.join("hooks", "post-commit"), "post-commit"],
  ["attribution-hook.js", "attribution-hook.js"],
];

// Keeps an ALREADY-installed repo's .githooks/ copies current with this extension's own
// scripts/ai-coauthoring-install/ source on every activation -- the per-repo mirror of
// syncGlobalSignalHookScript below. Installing hooks into a repo for the FIRST time changes
// what git actually runs there, so that stays an explicit opt-in (promptInstallHooks, above).
// But once installed, .githooks/ is a directory only this extension ever writes to
// (install-hooks.sh refuses to touch core.hooksPath at all if anything else already claimed
// it), so refreshing files inside it -- e.g. picking up a bug fix in attribution-hook.js after
// a version bump -- changes nothing about what the user consented to, and doing it silently is
// what saves every existing clone from needing a manual re-run of install-hooks.sh per repo.
// Content-compared per file so this is a no-op (no writes, no mtime churn) once already current.
function syncRepoHooksIfInstalled(context: vscode.ExtensionContext, repoRoot: string): void {
  if (!isHooksInstalled(repoRoot)) return; // not installed here -- promptInstallHooks handles that path
  void recordRepoHooksInstalled(context, repoRoot);

  const installScriptPath = findInstallHooksScript(repoRoot);
  if (!installScriptPath) return; // neither this repo nor the extension itself ships the install script
  const sourceDir = path.dirname(installScriptPath);
  const hooksDir = path.join(repoRoot, ".githooks");

  let changedAny = false;
  for (const [sourceRelPath, targetName] of REPO_HOOK_FILES_TO_SYNC) {
    const sourcePath = path.join(sourceDir, sourceRelPath);
    const targetPath = path.join(hooksDir, targetName);
    try {
      const source = fs.readFileSync(sourcePath, "utf8");
      const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
      if (existing === source) continue; // already current
      fs.writeFileSync(targetPath, source, "utf8");
      fs.chmodSync(targetPath, 0o755);
      changedAny = true;
    } catch (error) {
      statsOutputChannel.appendLine(
        `AI Co-Authoring Tracker: couldn't refresh .githooks/${targetName} for this repo: ${String(error)}`
      );
    }
  }

  if (changedAny) {
    statsOutputChannel.appendLine(
      "AI Co-Authoring Tracker: refreshed this repo's git hooks (.githooks/) to match the installed extension version."
    );
  }
}

// Global (per-machine, cross-workspace) registry of every repo this extension has seen with
// git hooks installed -- recorded on every activation where isHooksInstalled() is true (fresh
// install via promptInstallHooks, an already-installed repo via syncRepoHooksIfInstalled, or an
// explicit reinstallHooksForThisRepo), so "list repos with hooks installed" has something to
// show without having to rescan every folder VS Code has ever opened.
const INSTALLED_REPOS_KEY = "aiCoauthoringTracker.installedRepos";

type InstalledRepoRecord = { lastSeenIso: string };
type InstalledReposMap = Record<string, InstalledRepoRecord>;

async function recordRepoHooksInstalled(context: vscode.ExtensionContext, repoRoot: string): Promise<void> {
  const repos = context.globalState.get<InstalledReposMap>(INSTALLED_REPOS_KEY) ?? {};
  repos[repoRoot] = { lastSeenIso: new Date().toISOString() };
  await context.globalState.update(INSTALLED_REPOS_KEY, repos);
}

// Shows every repo on this machine the extension has recorded hooks in, newest-seen first.
// Selecting one reveals it in the OS file manager -- mostly so the list is more than a dead
// end, not because that's the main point of the command.
async function listInstalledRepos(context: vscode.ExtensionContext): Promise<void> {
  const repos = context.globalState.get<InstalledReposMap>(INSTALLED_REPOS_KEY) ?? {};
  const entries = Object.entries(repos).sort((a, b) => b[1].lastSeenIso.localeCompare(a[1].lastSeenIso));

  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      "AI Co-Authoring Tracker: no repos with git hooks tracked yet on this machine -- open a repo with hooks installed (or install them from the sidebar) to add it here."
    );
    return;
  }

  const items: vscode.QuickPickItem[] = entries.map(([repoRoot, record]) => ({
    label: path.basename(repoRoot),
    description: repoRoot,
    detail: `Last seen: ${new Date(record.lastSeenIso).toLocaleString()}`,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `AI Co-Authoring Tracker: ${entries.length} repo${entries.length === 1 ? "" : "s"} with git hooks installed`,
    placeHolder: "Select a repo to reveal it in your file manager",
  });
  if (!picked?.description) return;
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(picked.description));
}

// Manual, explicit "(re)install for this repo" -- unlike promptInstallHooks (which only ever
// offers to install once, the first time a repo is opened) and syncRepoHooksIfInstalled (which
// silently keeps an already-installed repo current), this always re-runs install-hooks.sh for
// the current workspace's repo on request, whether or not hooks are already installed there.
// install-hooks.sh itself already overwrites its own previously-installed files unconditionally
// (it only ever refuses to touch core.hooksPath if a DIFFERENT tool claimed it first) -- so this
// is just that same script, exposed as an explicit command/button instead of only ever running
// automatically, for whenever the user wants to force a repo current without waiting for VS
// Code's next activation of that window.
async function reinstallHooksForThisRepo(context: vscode.ExtensionContext): Promise<void> {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showErrorMessage("AI Co-Authoring Tracker: no repository open in this workspace.");
    return;
  }

  const scriptPath = findInstallHooksScript(repoRoot);
  if (!scriptPath) {
    vscode.window.showErrorMessage("AI Co-Authoring Tracker: couldn't find install-hooks.sh for this repo.");
    return;
  }

  const alreadyInstalled = isHooksInstalled(repoRoot);
  const confirmLabel = alreadyInstalled ? "Reinstall" : "Install";
  const selection = await vscode.window.showInformationMessage(
    alreadyInstalled
      ? "This will overwrite this repo's .githooks/ files with the currently installed extension version. Continue?"
      : "Install AI Co-Authoring Tracker's git hooks for this repo?",
    confirmLabel,
    "Cancel"
  );
  if (selection !== confirmLabel) return;

  try {
    const output = execFileSync("bash", [scriptPath], { cwd: repoRoot, encoding: "utf8" });
    vscode.window.showInformationMessage(
      alreadyInstalled
        ? "AI Co-Authoring Tracker: git hooks reinstalled for this repo."
        : "AI Co-Authoring Tracker: git hooks installed for this repo."
    );
    if (output.trim()) {
      statsOutputChannel.appendLine(output.trim());
    }
    await addGlobalVsCodeExcludes();
    await recordRepoHooksInstalled(context, repoRoot);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? err.stderr.toString() : err.message) ?? String(error);
    vscode.window.showErrorMessage(`Failed to (re)install AI Co-Authoring Tracker's git hooks: ${detail.trim()}`);
    statsOutputChannel.appendLine(`AI Co-Authoring Tracker: hook (re)install failed:\n${detail.trim()}`);
    statsOutputChannel.show(true);
  }
}

// ---- Claude Code CLI activity-signal hook (global, auto-installed) ------------------------
//
// Unlike the git commit hooks above (per-repo, git-native, and intentionally left to an
// explicit per-repo prompt so this extension never risks trampling another repo's own hook
// manager), the signal that tells this extension "Claude Code just touched this exact file"
// comes from a Claude Code CLI hook -- a different kind of thing entirely, configured in the
// user's GLOBAL ~/.claude/settings.json, not per-repo git config. Because it's global, it only
// needs installing ONCE per machine to cover every repository Claude Code ever touches -- and
// because it's the extension's own script being registered (not something a user hand-writes
// into JSON), every user who installs this extension gets it automatically.

const CLAUDE_SETTINGS_DIRNAME = ".claude";
const SIGNAL_HOOK_DIRNAME = "ai-coauthoring";
const SIGNAL_HOOK_FILENAME = "claude-signal-hook.js";

type ClaudeHookEntry = { type: string; command: string };
type ClaudeHookMatcherGroup = { matcher?: string; hooks: ClaudeHookEntry[] };
type ClaudeSettingsHooks = Record<string, ClaudeHookMatcherGroup[]>;
// Deliberately loose beyond `hooks` (a `[key: string]: unknown` index signature) -- this is the
// user's real global Claude Code config, which can have any number of other keys (attribution,
// permissions, ...) that must be read back out and preserved exactly as-is, never modeled or
// pruned by this extension.
type ClaudeSettings = {
  hooks?: ClaudeSettingsHooks;
  [key: string]: unknown;
};

function getGlobalClaudeDir(): string {
  return path.join(os.homedir(), CLAUDE_SETTINGS_DIRNAME);
}

function getGlobalClaudeSettingsPath(): string {
  return path.join(getGlobalClaudeDir(), "settings.json");
}

// The per-machine copy Claude Code's hook config actually points at. Lives outside any specific
// repo -- a global hook fires regardless of which project is open -- and is kept in sync with
// this extension's own bundled copy on every activation (see syncGlobalSignalHookScript), so an
// extension update rolls out to it automatically without the user reinstalling anything.
function getGlobalSignalHookScriptPath(): string {
  return path.join(getGlobalClaudeDir(), SIGNAL_HOOK_DIRNAME, SIGNAL_HOOK_FILENAME);
}

// Mirrors findAttributionHookScript's fallback order: prefer a copy the workspace repo ships
// itself (so a repo can pin/version its own copy), falling back to the one bundled inside this
// extension's own install directory -- without that fallback, this would only ever work when
// someone happens to have this extension's own source open as their workspace.
function findSignalHookSourceScript(repoRoot: string | null): string | null {
  const candidates = [
    repoRoot ? path.join(repoRoot, "scripts", "ai-coauthoring-install", SIGNAL_HOOK_FILENAME) : null,
    extensionInstallPath ? path.join(extensionInstallPath, "scripts", "ai-coauthoring-install", SIGNAL_HOOK_FILENAME) : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// Copies the current source script over the global per-machine copy, creating
// ~/.claude/ai-coauthoring/ if needed. Silent and side-effect-only (no prompt) -- unlike
// registering the hook in settings.json, overwriting this file changes nothing about what the
// user has consented to, so it's safe to just keep it current on every activation. Skips the
// write if the content hasn't actually changed, so this doesn't touch the file's mtime on every
// single VS Code startup for no reason.
function syncGlobalSignalHookScript(repoRoot: string | null): boolean {
  const sourcePath = findSignalHookSourceScript(repoRoot);
  if (!sourcePath) return false;

  const targetPath = getGlobalSignalHookScriptPath();
  const source = fs.readFileSync(sourcePath, "utf8");
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  if (existing === source) return true; // already current, nothing to write

  ensureParentDir(targetPath);
  fs.writeFileSync(targetPath, source, "utf8");
  return true;
}

type GlobalClaudeSettingsRead =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "ok"; settings: ClaudeSettings };

function readGlobalClaudeSettings(): GlobalClaudeSettingsRead {
  const settingsPath = getGlobalClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return { status: "missing" };
  const parsed = readJsonFile<ClaudeSettings>(settingsPath);
  if (!parsed || typeof parsed !== "object") return { status: "malformed" };
  return { status: "ok", settings: parsed };
}

function isSignalHookRegisteredGlobally(): boolean {
  const read = readGlobalClaudeSettings();
  if (read.status !== "ok") return false;
  const postToolUse = read.settings.hooks?.PostToolUse ?? [];
  return postToolUse.some((group) =>
    (group.hooks ?? []).some(
      (h) => typeof h.command === "string" && h.command.includes(`${SIGNAL_HOOK_DIRNAME}/${SIGNAL_HOOK_FILENAME}`)
    )
  );
}

// Registers the global PostToolUse hook pointing at the synced per-machine script, merging into
// whatever's already at ~/.claude/settings.json rather than replacing it: existing hooks (for
// other matchers, or unrelated tools entirely) are appended alongside, never overwritten, and
// every other top-level key (attribution, permissions, ...) is preserved exactly as-is. Refuses
// to touch anything if the existing file fails to parse -- a real, malformed user config must
// never be silently clobbered, even to add something as small as one hook entry.
async function installGlobalSignalHook(): Promise<boolean> {
  const read = readGlobalClaudeSettings();
  if (read.status === "malformed") {
    vscode.window.showErrorMessage(
      `AI Co-Authoring Tracker: ${getGlobalClaudeSettingsPath()} exists but isn't valid JSON -- leaving it untouched. Fix or back it up, then run "AI Co-Authoring Tracker: Install Claude Code Activity Hook" again.`
    );
    return false;
  }

  const scriptPath = getGlobalSignalHookScriptPath();
  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage(
      "AI Co-Authoring Tracker: the Claude Code activity-signal script hasn\'t been synced yet -- try reloading the window, then run this command again."
    );
    return false;
  }

  const settings: ClaudeSettings = read.status === "ok" ? read.settings : {};
  const hooks: ClaudeSettingsHooks = settings.hooks ?? {};
  const postToolUse: ClaudeHookMatcherGroup[] = [...(hooks.PostToolUse ?? [])];

  postToolUse.push({
    matcher: "Edit|Write|MultiEdit",
    hooks: [{ type: "command", command: `node "${scriptPath}"` }],
  });

  const next: ClaudeSettings = { ...settings, hooks: { ...hooks, PostToolUse: postToolUse } };

  const settingsPath = getGlobalClaudeSettingsPath();
  ensureParentDir(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

const SIGNAL_HOOK_PROMPT_DISMISSED_KEY = "aiCoauthoringTracker.signalHookPromptDismissed";

// One-time, global prompt -- deliberately separate from promptInstallHooks (the per-repo git
// hooks): this mutates the user's global Claude Code CLI config, not anything inside the
// current repo, so it only ever needs asking once per machine and then applies to every repo
// from then on. See installGlobalSignalHook for what "Install" actually does.
async function promptInstallGlobalSignalHook(context: vscode.ExtensionContext) {
  if (isSignalHookRegisteredGlobally()) return;
  if (context.globalState.get<boolean>(SIGNAL_HOOK_PROMPT_DISMISSED_KEY)) return;

  const selection = await vscode.window.showInformationMessage(
    "AI Co-Authoring Tracker can register a Claude Code CLI hook (global, one-time) so it detects exactly which file Claude Code just edited, in every repository -- instead of only guessing from edit shape. Install it?",
    "Install",
    "Don't show again"
  );

  if (selection === "Install") {
    const installed = await installGlobalSignalHook();
    if (installed) {
      vscode.window.showInformationMessage("AI Co-Authoring Tracker: Claude Code activity-signal hook installed globally.");
    }
  } else if (selection === "Don't show again") {
    await context.globalState.update(SIGNAL_HOOK_PROMPT_DISMISSED_KEY, true);
  }
}

function isGhCliAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GH_WARNING_DISMISSED_KEY = "aiCoauthoringTracker.ghWarningDismissed";

// GitHub CLI (`gh`) is a hard prerequisite for the PR-time attribution summary feature --
// it's how the extension reads/writes PR descriptions. There's no way to silently install
// or authenticate it on the user's behalf, so we just warn clearly and point at the docs.
async function checkGhPrerequisite(context: vscode.ExtensionContext) {
  if (isGhCliAvailable()) return;
  if (context.globalState.get<boolean>(GH_WARNING_DISMISSED_KEY)) return;

  const selection = await vscode.window.showWarningMessage(
    "AI Co-Authoring Tracker requires the GitHub CLI (gh) to summarize AI attribution on pull requests. Install it and run `gh auth login`, then reload the window.",
    "Install GitHub CLI",
    "Don't show again"
  );

  if (selection === "Install GitHub CLI") {
    void vscode.env.openExternal(vscode.Uri.parse("https://cli.github.com/"));
  } else if (selection === "Don't show again") {
    await context.globalState.update(GH_WARNING_DISMISSED_KEY, true);
  }
}

async function detectProviderFromQuickPick() {
  const choice = await vscode.window.showQuickPick(
    getConfiguredProviders().map((p) => ({ label: p.label, provider: p.id })),
    { placeHolder: "Select AI provider to attribute upcoming edits" }
  );

  if (!choice) return;
  setActiveProvider(choice.provider, "manual selection");
  vscode.window.showInformationMessage(`${choice.label} attribution enabled temporarily.`);
}

// Walks .git/ai-attribution/ and returns every branch name that has recorded data (character
// stats, session state, and/or a commit snapshot). Branch names containing "/" are stored as
// nested directories (e.g. "feature/foo" -> ai-attribution/feature/foo/), so this recurses to
// find leaf branches at any depth rather than assuming one directory level.
function listAttributionBranches(repoRoot: string): string[] {
  const attributionDir = path.join(getCachedGitDir(repoRoot), "ai-attribution");
  const branches: string[] = [];

  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const branchSegment = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullDir = path.join(dir, entry.name);
      const isLeafBranch =
        fs.existsSync(path.join(fullDir, "char-stats.json")) ||
        fs.existsSync(path.join(fullDir, "state.json")) ||
        fs.existsSync(path.join(fullDir, "commit-snapshot.json"));
      if (isLeafBranch) branches.push(branchSegment);
      walk(fullDir, branchSegment);
    }
  }

  walk(attributionDir, "");
  return branches;
}

type CharBreakdownTotals = {
  manual: number;
  byProvider: ProviderCharCounts;
  unknown: number;
  total: number;
};

type BranchReportRow = CharBreakdownTotals & {
  branch: string;
  lastModified: string;
};

// Per-file counterpart to BranchReportRow -- "which model changed this file", scoped to a
// single branch (a file's per-provider split only means something within one branch's tree).
type FileReportRow = CharBreakdownTotals & {
  path: string;
  lastModified: string;
};

function buildBranchReport(repoRoot: string): BranchReportRow[] {
  const rows: BranchReportRow[] = [];
  for (const branch of listAttributionBranches(repoRoot)) {
    const raw = readJsonFile<unknown>(getCharStatsPath(repoRoot, branch));
    const state = upgradeCharStatsState(raw);
    let manual = 0;
    let unknown = 0;
    const byProvider: ProviderCharCounts = {};
    let lastModified = "";
    if (state?.files) {
      for (const [relativePath, stats] of Object.entries(state.files)) {
        if (!fileExistsForBranch(repoRoot, branch, relativePath)) continue;
        manual += stats.manual;
        unknown += stats.unknown;
        for (const [provider, count] of Object.entries(stats.byProvider)) {
          byProvider[provider as Provider] = (byProvider[provider as Provider] ?? 0) + (count ?? 0);
        }
        if (stats.lastModified > lastModified) lastModified = stats.lastModified;
      }
    }
    const providerTotal = Object.values(byProvider).reduce((sum: number, n) => sum + (n ?? 0), 0);
    rows.push({ branch, manual, byProvider, unknown, total: manual + providerTotal + unknown, lastModified });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

function buildFileReport(repoRoot: string, branch: string): FileReportRow[] {
  const raw = readJsonFile<unknown>(getCharStatsPath(repoRoot, branch));
  const state = upgradeCharStatsState(raw);
  const rows: FileReportRow[] = [];
  if (state?.files) {
    for (const [relativePath, stats] of Object.entries(state.files)) {
      if (!fileExistsForBranch(repoRoot, branch, relativePath)) continue;
      const providerTotal = Object.values(stats.byProvider).reduce((sum: number, n) => sum + (n ?? 0), 0);
      rows.push({
        path: relativePath,
        manual: stats.manual,
        byProvider: stats.byProvider,
        unknown: stats.unknown,
        total: stats.manual + providerTotal + stats.unknown,
        lastModified: stats.lastModified,
      });
    }
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// Quick-scan label for "which model changed this file" -- the bar next to it already shows the
// exact split, but a single word is faster to eyeball down a long file list. >=90% share counts
// as clearly one source; anything else is called out as mixed rather than overstating it as
// belonging to whichever source happens to be largest.
function dominantContributor(row: CharBreakdownTotals): string {
  if (row.total === 0) return "\u2014";
  const candidates: Array<[string, number]> = [
    ["Manual", row.manual],
    ...getConfiguredProviders().map((p): [string, number] => [p.label, row.byProvider[p.id] ?? 0]),
    ["Unclear", row.unknown],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  const [topLabel, topCount] = candidates[0];
  if (topCount === 0) return "\u2014";
  return topCount / row.total >= 0.9 ? topLabel : `${topLabel} (mixed)`;
}

function formatPercent(part: number, total: number): string {
  if (total === 0) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function branchDisplayLabel(branch: string): string {
  return branch === LEGACY_BRANCH_DIR ? "(legacy, unscoped)" : branch;
}

// Whether `relativePath` currently exists for `branch` -- used to exclude deleted/stashed-away
// files from the branch report the same way computeAggregate() does for the live status bar.
// The legacy (pre-per-branch) bucket isn't a real ref, so it's never filtered: there's nothing
// to check it against. For the branch actually checked out right now, a plain disk check is
// correct and cheap. For any other branch, the working tree doesn't reflect it at all, so a
// disk check would be meaningless (or wrong) -- ask git directly whether that path exists in
// that branch's tree instead, without checking it out.
function fileExistsForBranch(repoRoot: string, branch: string, relativePath: string): boolean {
  if (branch === LEGACY_BRANCH_DIR) return true;
  if (branch === getCurrentBranchCached(repoRoot)) {
    return fs.existsSync(path.join(repoRoot, relativePath));
  }
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${branch}:${relativePath}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function percentValue(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

function sumRows(rows: BranchReportRow[]): BranchReportRow {
  const grand: BranchReportRow = { branch: "", manual: 0, byProvider: {}, unknown: 0, total: 0, lastModified: "" };
  for (const row of rows) {
    grand.manual += row.manual;
    grand.unknown += row.unknown;
    grand.total += row.total;
    for (const [provider, count] of Object.entries(row.byProvider)) {
      grand.byProvider[provider as Provider] = (grand.byProvider[provider as Provider] ?? 0) + (count ?? 0);
    }
  }
  return grand;
}

// Renders one row's manual/claude/copilot/unclear split as a horizontal stacked bar. Fixed
// left-to-right segment order (never reordered per row) so color always means the same thing
// down the table. A zero-total row (data directory exists but nothing was ever recorded in it)
// gets a flat muted placeholder instead of four zero-width segments.
function renderStackedBar(row: CharBreakdownTotals): string {
  if (row.total === 0) {
    return `<div class="bar bar-empty" title="No characters recorded yet"></div>`;
  }
  // Manual and Unclear keep their fixed CSS classes; each configured provider gets an inline
  // background color instead, since the set of providers (and their colors) isn't known until
  // this page is built.
  const segments: Array<{ pct: number; cls: string; extraStyle: string; label: string }> = [
    {
      pct: percentValue(row.manual, row.total),
      cls: "seg-manual",
      extraStyle: "",
      label: `Manual ${formatPercent(row.manual, row.total)}`,
    },
    ...getConfiguredProviders().map((p) => ({
      pct: percentValue(row.byProvider[p.id] ?? 0, row.total),
      cls: "",
      extraStyle: `background:${p.color};`,
      label: `${p.label} ${formatPercent(row.byProvider[p.id] ?? 0, row.total)}`,
    })),
    {
      pct: percentValue(row.unknown, row.total),
      cls: "seg-unclear",
      extraStyle: "",
      label: `Unclear ${formatPercent(row.unknown, row.total)}`,
    },
  ];
  return `<div class="bar" role="img" aria-label="${escapeHtml(
    segments.map((s) => s.label).join(", ")
  )}">${segments
    .filter((s) => s.pct > 0)
    .map((s) => `<span class="${s.cls}" style="${s.extraStyle}width:${s.pct}%" title="${escapeHtml(s.label)}"></span>`)
    .join("")}</div>`;
}

function providerTableCellsHtml(row: CharBreakdownTotals): string {
  return getConfiguredProviders()
    .map((p) => `<td class="col-num">${formatPercent(row.byProvider[p.id] ?? 0, row.total)}</td>`)
    .join("\n    ");
}

function renderBranchRow(row: BranchReportRow, isTotal: boolean): string {
  const label = isTotal ? "All branches" : branchDisplayLabel(row.branch);
  const rowClass = isTotal ? ' class="total-row"' : "";
  const updated = row.lastModified ? row.lastModified.slice(0, 19).replace("T", " ") : "—";
  return `<tr${rowClass}>
    <td class="col-branch">${escapeHtml(label)}</td>
    <td class="col-bar">${renderStackedBar(row)}</td>
    <td class="col-num">${row.total.toLocaleString()}</td>
    <td class="col-num">${formatPercent(row.manual, row.total)}</td>
    ${providerTableCellsHtml(row)}
    <td class="col-num">${formatPercent(row.unknown, row.total)}</td>
    <td class="col-updated">${escapeHtml(updated)}</td>
  </tr>`;
}

function renderFileRow(row: FileReportRow): string {
  const updated = row.lastModified ? row.lastModified.slice(0, 19).replace("T", " ") : "\u2014";
  return `<tr>
    <td class="col-branch">${escapeHtml(row.path)}</td>
    <td class="col-primary">${escapeHtml(dominantContributor(row))}</td>
    <td class="col-bar">${renderStackedBar(row)}</td>
    <td class="col-num">${row.total.toLocaleString()}</td>
    <td class="col-num">${formatPercent(row.manual, row.total)}</td>
    ${providerTableCellsHtml(row)}
    <td class="col-num">${formatPercent(row.unknown, row.total)}</td>
    <td class="col-updated">${escapeHtml(updated)}</td>
  </tr>`;
}

function providerTableHeadersHtml(): string {
  return getConfiguredProviders()
    .map((p) => `<th class="col-num">${escapeHtml(p.label)}</th>`)
    .join("\n          ");
}

// Per-file section of the branch report -- "which model changed which file", scoped to whatever
// branch is currently checked out (a per-provider split only means something within one branch's
// tree, unlike the cross-branch totals table above it).
function getFileReportSectionHtml(rows: FileReportRow[], branch: string): string {
  const heading = `<h2>Files on ${escapeHtml(branchDisplayLabel(branch))}</h2>`;
  if (rows.length === 0) {
    return `${heading}<p class="empty-state">No per-file attribution data recorded yet for this branch.</p>`;
  }
  const rowsHtml = rows.map((r) => renderFileRow(r)).join("\n");
  return `${heading}
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Primary</th>
          <th>Split</th>
          <th class="col-num">Total</th>
          <th class="col-num">Manual</th>
          ${providerTableHeadersHtml()}
          <th class="col-num">Unclear</th>
          <th>Last updated</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>`;
}

function getBranchReportHtml(rows: BranchReportRow[], fileRows: FileReportRow[], currentBranch: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
  const head = `<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px 32px;
    }
    h1 { font-size: 1.3em; margin: 0 0 4px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
    .legend { display: flex; gap: 18px; align-items: center; margin: 0 0 16px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .swatch-manual { background: var(--vscode-charts-blue); }
    .swatch-unclear { background: var(--vscode-descriptionForeground); opacity: 0.6; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
    th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.02em; }
    .col-bar { width: 160px; }
    .col-primary { color: var(--vscode-descriptionForeground); }
    .col-num { text-align: right; font-variant-numeric: tabular-nums; }
    .col-updated { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--vscode-panel-border); min-width: 120px; }
    .bar span { height: 100%; }
    .bar-empty { opacity: 0.35; }
    .seg-manual { background: var(--vscode-charts-blue); }
    .seg-unclear { background: var(--vscode-descriptionForeground); opacity: 0.6; }
    tr.total-row td { border-top: 2px solid var(--vscode-panel-border); border-bottom: none; font-weight: 600; }
    .footnote { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 18px; line-height: 1.5; }
    .empty-state { color: var(--vscode-descriptionForeground); margin-top: 12px; }
    h2 { font-size: 1.05em; margin: 0 0 4px; }

    /* Pure-CSS tabs: two hidden radios (first in the body, so the general-sibling combinator
       below can reach both the nav and the panels) plus <label for="..."> elements as the
       clickable tabs. Clicking a label toggles its radio's checked state natively -- no
       navigation, no anchor href, nothing for a webview host to intercept -- so this can't
       silently no-op the way the previous #fragment/:target version did. */
    .tab-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .tab-nav {
      display: inline-flex;
      gap: 2px;
      margin: 6px 0 20px;
      padding: 3px;
      background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.06));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
    }
    .tab-link {
      display: inline-block;
      padding: 6px 14px;
      font-size: 0.85em;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .tab-link:hover { color: var(--vscode-editor-foreground); }
    .tab-panel { display: none; }
    #tab-radio-branches:checked ~ #tab-branches { display: block; }
    #tab-radio-files:checked ~ #tab-files { display: block; }
    #tab-radio-branches:checked ~ .tab-nav label[for="tab-radio-branches"],
    #tab-radio-files:checked ~ .tab-nav label[for="tab-radio-files"] {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
  </style>`;

  const providerLegendItemsHtml = getConfiguredProviders()
    .map(
      (p) =>
        `<span class="legend-item"><span class="swatch" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.label)}</span>`
    )
    .join("\n    ");
  const legend = `<div class="legend">
    <span class="legend-item"><span class="swatch swatch-manual"></span>Manual</span>
    ${providerLegendItemsHtml}
    <span class="legend-item"><span class="swatch swatch-unclear"></span>Unclear</span>
  </div>`;

  let body: string;
  if (rows.length === 0) {
    body = `<p class="empty-state">No branch attribution data recorded yet. Start editing with a session active (or let auto-detect start one) and this report will fill in.</p>`;
  } else {
    const grand = sumRows(rows);
    const rowsHtml = rows.map((r) => renderBranchRow(r, false)).join("\n");
    body = `${legend}
    <table>
      <thead>
        <tr>
          <th>Branch</th>
          <th>Split</th>
          <th class="col-num">Total</th>
          <th class="col-num">Manual</th>
          ${providerTableHeadersHtml()}
          <th class="col-num">Unclear</th>
          <th>Last updated</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        ${renderBranchRow(grand, true)}
      </tbody>
    </table>
    <p class="footnote">
      "Unclear" = AI-shaped edits (fast/multi-char insertions) with no active provider session running at the time, so the specific tool can't be identified. Start a session (or let auto-detect start one on a large applied diff) to get real per-provider numbers instead.<br>
      This is local-machine data only (nothing here is committed or shared), and only covers edits made since tracking started on each branch.
    </p>`;
  }

  const fileSection = getFileReportSectionHtml(fileRows, currentBranch);

  return `<!DOCTYPE html>
<html lang="en">
<head>${head}</head>
<body>
  <input type="radio" name="report-tab" id="tab-radio-branches" class="tab-radio" checked>
  <input type="radio" name="report-tab" id="tab-radio-files" class="tab-radio">
  <h1>AI Co-Authoring Tracker — Branch Report</h1>
  <nav class="tab-nav">
    <label class="tab-link" for="tab-radio-branches">Branches Overview</label>
    <label class="tab-link" for="tab-radio-files">Branch Files AI Breakdown</label>
  </nav>
  <div id="tab-branches" class="tab-panel">
    <p class="subtitle">Manual vs. AI (by provider) split of tracked character-level edits, per branch.</p>
    ${body}
  </div>
  <div id="tab-files" class="tab-panel">
    ${fileSection}
  </div>
</body>
</html>`;
}

// Opens (or reveals, if already open) a single Webview tab rendering the cross-branch
// manual/Claude/Copilot/unclear split as an HTML report -- reused rather than reopened on every
// invocation so re-running the command just refreshes the same tab instead of piling up
// duplicates. Only reflects data recorded since this extension started tracking (and, for
// anything predating per-branch tracking, whatever was migrated into the "(legacy, unscoped)"
// row) -- it can't retroactively attribute history from before install.
function showBranchReport() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a Git repository to view the AI attribution branch report.");
    return;
  }

  // Make sure the branch we're currently sitting on is flushed to disk before reading it back.
  if (statsPersistTimer && statsLoadedForBranch) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
    persistCharStatsNow(repoRoot, statsLoadedForBranch);
  }

  const currentBranch = getCurrentBranchCached(repoRoot);
  const rows = buildBranchReport(repoRoot);
  const fileRows = buildFileReport(repoRoot, currentBranch);
  const html = getBranchReportHtml(rows, fileRows, currentBranch);

  if (branchReportPanel) {
    branchReportPanel.webview.html = html;
    branchReportPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  branchReportPanel = vscode.window.createWebviewPanel(
    "aiCoauthoringTrackerBranchReport",
    "AI Co-Authoring Tracker: Branch Report",
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );
  branchReportPanel.webview.html = html;
  branchReportPanel.onDidDispose(() => {
    branchReportPanel = undefined;
  });
}


// Resets character stats + session state + the commit-attribution snapshot for the CURRENT
// branch only. Requires an explicit modal confirmation -- this permanently deletes on-disk
// data and cannot be undone. The commit snapshot MUST be cleared alongside char-stats, or the
// next commit's trailer calculation would diff fresh (zeroed) stats against a stale, larger
// snapshot and silently produce no trailer at all until stats grow back past the old baseline.
async function resetCurrentBranchStats() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a Git repository to reset AI attribution data.");
    return;
  }
  const branch = getCurrentBranchCached(repoRoot);

  const confirmation = await vscode.window.showWarningMessage(
    `Reset all AI attribution data for branch "${branch}"? This deletes its character stats, session history, and commit-attribution baseline, and cannot be undone.`,
    { modal: true },
    "Reset This Branch"
  );
  if (confirmation !== "Reset This Branch") return;

  if (statsPersistTimer) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
  }
  if (activeSession) clearActiveSession();

  const statsPath = getCharStatsPath(repoRoot, branch);
  if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath);
  const snapshotPath = getCommitSnapshotPath(repoRoot, branch);
  if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
  clearState(repoRoot, branch);

  loadCharStatsForBranch(repoRoot, branch, true);
  renderStatsStatusBar();
  statsTreeProvider.refresh();
  vscode.window.showInformationMessage(`AI attribution data for branch "${branch}" has been reset.`);
}

// Resets character stats + session state for EVERY branch in this repository (this also wipes
// every branch's commit-attribution snapshot, since the whole ai-attribution/ tree is removed).
// Requires an explicit modal confirmation -- this permanently deletes on-disk data and cannot
// be undone.
async function resetAllAttributionData() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a Git repository to reset AI attribution data.");
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    "Reset ALL AI attribution data for every branch in this repository? This permanently deletes every branch's character stats, session history, and commit-attribution baseline, and cannot be undone.",
    { modal: true },
    "Reset All Branches"
  );
  if (confirmation !== "Reset All Branches") return;

  if (statsPersistTimer) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
  }
  if (activeSession) clearActiveSession();

  const attributionDir = path.join(getCachedGitDir(repoRoot), "ai-attribution");
  try {
    fs.rmSync(attributionDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  const branch = getCurrentBranchCached(repoRoot);
  loadCharStatsForBranch(repoRoot, branch, true);
  renderStatsStatusBar();
  statsTreeProvider.refresh();
  vscode.window.showInformationMessage("All AI attribution data has been reset across every branch.");
}

function isNodeAvailable(): boolean {
  try {
    execFileSync("node", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The commit-trailer logic lives in a standalone Node script (not in this extension) because
// it also has to run from a plain git hook, outside any running VS Code process. Prefer the
// canonical copy under scripts/ (works even before hooks are installed); fall back to the
// installed copy under .githooks/ if the canonical one is missing for some reason.
function findAttributionHookScript(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, "scripts", "ai-coauthoring-install", "attribution-hook.js"),
    path.join(repoRoot, ".githooks", "attribution-hook.js"),
    extensionInstallPath ? path.join(extensionInstallPath, "scripts", "ai-coauthoring-install", "attribution-hook.js") : null,
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// Shows what the NEXT commit's "AI-Coauthoring:" trailer would look like, without making a
// commit -- lets you sanity-check the hook is wired up correctly before trusting it.
function previewCommitTrailer() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a Git repository to preview the commit attribution trailer.");
    return;
  }
  if (!isNodeAvailable()) {
    vscode.window.showErrorMessage("AI Co-Authoring Tracker: Node.js is required to compute the commit attribution trailer, but wasn't found on PATH.");
    return;
  }
  const scriptPath = findAttributionHookScript(repoRoot);
  if (!scriptPath) {
    vscode.window.showInformationMessage(
      'No attribution hook script found in this repository. Run "AI Co-Authoring Tracker: Select Provider" once to activate tracking, then reload -- if the prompt to install hooks doesn\'t reappear, this repo may not have scripts/ai-coauthoring-install/ at all.'
    );
    return;
  }

  // Make sure whatever's pending in memory is flushed to disk before the standalone script reads it.
  if (statsPersistTimer && statsLoadedForBranch) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
    persistCharStatsNow(repoRoot, statsLoadedForBranch);
  }

  try {
    const output = execFileSync("node", [scriptPath, "preview"], { cwd: repoRoot, encoding: "utf8" });
    statsOutputChannel.clear();
    statsOutputChannel.appendLine(output.trim());
    statsOutputChannel.show(true);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? err.stderr.toString() : err.message) ?? String(error);
    vscode.window.showErrorMessage(`Failed to preview commit attribution: ${detail.trim()}`);
  }
}

// Shows what the AI-attribution block would look like in the current branch's PR description,
// without touching anything (no `gh` calls at all -- purely local, so this works even without
// `gh` installed/authenticated).
function previewPrSummary() {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage("Open a Git repository to preview the PR attribution summary.");
    return;
  }
  if (!isNodeAvailable()) {
    vscode.window.showErrorMessage("AI Co-Authoring Tracker: Node.js is required to compute the PR attribution summary, but wasn't found on PATH.");
    return;
  }
  const scriptPath = findAttributionHookScript(repoRoot);
  if (!scriptPath) {
    vscode.window.showInformationMessage("No attribution hook script found in this repository.");
    return;
  }

  if (statsPersistTimer && statsLoadedForBranch) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
    persistCharStatsNow(repoRoot, statsLoadedForBranch);
  }

  try {
    const output = execFileSync("node", [scriptPath, "pr-block"], { cwd: repoRoot, encoding: "utf8" });
    statsOutputChannel.clear();
    statsOutputChannel.appendLine("This is what would be inserted into the PR description:");
    statsOutputChannel.appendLine("");
    statsOutputChannel.appendLine(output.trim());
    statsOutputChannel.show(true);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr ? err.stderr.toString() : err.message) ?? String(error);
    vscode.window.showErrorMessage(`Failed to preview PR attribution summary: ${detail.trim()}`);
  }
}

// Creates a PR for the current branch (if none exists) or updates the existing one, inserting
// or refreshing an AI-attribution block in its description via `gh`. This is the one command
// in this extension that actually mutates GitHub state, so it asks for explicit confirmation
// first and surfaces whatever `gh` itself reports on failure (not authenticated, no remote,
// network error, etc.) rather than swallowing it.
type PrPreflight = { repoRoot: string; scriptPath: string };

// Shared checks for every PR command; shows the reason and returns null if any fails.
function prPreflight(action: string): PrPreflight | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    vscode.window.showInformationMessage(`Open a Git repository to ${action}.`);
    return null;
  }
  if (!isGhCliAvailable()) {
    vscode.window.showErrorMessage(
      "AI Co-Authoring Tracker: the GitHub CLI (gh) is required for this. Install it and run `gh auth login` first."
    );
    return null;
  }
  if (!isNodeAvailable()) {
    vscode.window.showErrorMessage("AI Co-Authoring Tracker: Node.js is required to compute the PR attribution summary, but wasn't found on PATH.");
    return null;
  }
  const scriptPath = findAttributionHookScript(repoRoot);
  if (!scriptPath) {
    vscode.window.showInformationMessage("No attribution hook script found in this repository.");
    return null;
  }
  flushPendingCharStats(repoRoot);
  return { repoRoot, scriptPath };
}

function flushPendingCharStats(repoRoot: string) {
  if (statsPersistTimer && statsLoadedForBranch) {
    clearTimeout(statsPersistTimer);
    statsPersistTimer = undefined;
    persistCharStatsNow(repoRoot, statsLoadedForBranch);
  }
}

function runAttributionScriptAsync(scriptPath: string, repoRoot: string, mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("node", [scriptPath, mode], { cwd: repoRoot, encoding: "utf8", timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || String(error)).toString().trim()));
      } else {
        resolve(stdout.toString().trim());
      }
    });
  });
}

// Asks `gh` (via the attribution script) whether the current branch has an OPEN PR, caches the
// answer, and pushes it to the panel so it shows "Create PR" or "Update PR description".
// Silent on failure (gh missing/unauthenticated/offline): state stays "unknown" and both show.
async function refreshPrState(repoRoot: string) {
  if (!isGhCliAvailable() || !isNodeAvailable()) return;
  const scriptPath = findAttributionHookScript(repoRoot);
  if (!scriptPath) return;
  const branchAtStart = getCurrentBranchCached(repoRoot);
  try {
    const out = await runAttributionScriptAsync(scriptPath, repoRoot, "pr-status");
    if (getCurrentBranchCached(repoRoot) !== branchAtStart) return; // branch changed meanwhile
    prState = JSON.parse(out).exists ? "open" : "none";
  } catch (error) {
    debugLog(`PR status check failed: ${(error as Error).message}`);
    prState = "unknown";
  }
  actionsPanelProvider?.postPrState();
}

// Creates a PR for the current branch. Never edits an existing one, and asks for explicit
// confirmation first because it mutates GitHub state.
async function createPullRequest() {
  const ctx = prPreflight("create a pull request");
  if (!ctx) return;

  await refreshPrState(ctx.repoRoot);
  if (prState === "open") {
    vscode.window.showInformationMessage("A pull request already exists for this branch -- use \"Update PR description\" instead.");
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    "This runs `gh pr create` for the current branch, with an AI attribution summary in the pull request description. Continue?",
    { modal: true },
    "Continue"
  );
  if (confirmation !== "Continue") return;

  try {
    const output = await runAttributionScriptAsync(ctx.scriptPath, ctx.repoRoot, "create-pr");
    statsOutputChannel.clear();
    statsOutputChannel.appendLine(output);
    statsOutputChannel.show(true);
    vscode.window.showInformationMessage("AI Co-Authoring Tracker: pull request created with the attribution summary. It will now refresh automatically whenever you push this branch.");
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create the pull request: ${(error as Error).message}`);
  }
  await refreshPrState(ctx.repoRoot);
}

// Updates the AI-attribution block on the branch's existing PR. Never creates a PR.
async function updatePullRequest() {
  const ctx = prPreflight("update a pull request");
  if (!ctx) return;

  try {
    const output = await runAttributionScriptAsync(ctx.scriptPath, ctx.repoRoot, "update-pr-only");
    statsOutputChannel.clear();
    statsOutputChannel.appendLine(output);
    statsOutputChannel.show(true);
    if (output.startsWith("No open pull request")) {
      prState = "none";
      actionsPanelProvider?.postPrState();
      vscode.window.showInformationMessage("There's no open pull request for this branch yet -- use \"Create PR\" first.");
    } else {
      prState = "open";
      actionsPanelProvider?.postPrState();
      vscode.window.showInformationMessage("AI Co-Authoring Tracker: pull request description updated.");
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to update the pull request: ${(error as Error).message}`);
  }
}

// Command Palette entry point: does whichever of create/update applies to this branch.
async function createOrUpdatePullRequest() {
  const repoRoot = getRepoRoot();
  if (repoRoot) await refreshPrState(repoRoot);
  if (prState === "open") {
    await updatePullRequest();
  } else {
    await createPullRequest();
  }
}

// ---- Automatic PR refresh after push ------------------------------------------------------
//
// Git has no post-push hook, but a successful push (from the terminal, VS Code, GitKraken,
// anywhere) updates the remote-tracking ref .git/refs/remotes/<remote>/<branch>. Watching that
// is the reliable "push finished" signal. On it, refresh the attribution block on the current
// branch's existing OPEN PR -- update-only, NEVER creating a PR.
function autoUpdatePrOnPushEnabled(): boolean {
  return vscode.workspace.getConfiguration("aiCoauthoringTracker").get<boolean>("autoUpdatePrOnPush", true);
}

function startRemoteRefWatcher(repoRoot: string) {
  if (remoteRefWatcher) return;
  const remotesDir = path.join(getCachedGitDir(repoRoot), "refs", "remotes");
  try {
    remoteRefWatcher = fs.watch(remotesDir, { recursive: true }, (_eventType: string, filename: string | null) => {
      if (!filename) return;
      const ref = filename.toString().replace(/\\/g, "/");
      if (ref.endsWith(".lock")) return;
      const branch = getCurrentBranchCached(repoRoot);
      const slash = ref.indexOf("/");
      if (slash === -1 || ref.slice(slash + 1) !== branch) return; // another branch / remote HEAD
      if (remoteRefDebounceTimer) clearTimeout(remoteRefDebounceTimer);
      remoteRefDebounceTimer = setTimeout(() => void autoUpdatePrAfterPush(repoRoot), 3000);
    });
  } catch {
    // refs/remotes missing (no remote yet) or not watchable -- auto-update just won't fire.
  }
}

function stopRemoteRefWatcher() {
  remoteRefWatcher?.close();
  remoteRefWatcher = null;
  if (remoteRefDebounceTimer) {
    clearTimeout(remoteRefDebounceTimer);
    remoteRefDebounceTimer = undefined;
  }
}

async function autoUpdatePrAfterPush(repoRoot: string) {
  if (!autoUpdatePrOnPushEnabled()) return;
  if (prAutoUpdateRunning) {
    prAutoUpdatePending = true;
    return;
  }
  if (!isGhCliAvailable() || !isNodeAvailable()) return;
  const scriptPath = findAttributionHookScript(repoRoot);
  if (!scriptPath) return;

  prAutoUpdateRunning = true;
  try {
    flushPendingCharStats(repoRoot);
    debugLog("push detected: refreshing the AI attribution block on this branch's PR (update-only)");
    const output = await runAttributionScriptAsync(scriptPath, repoRoot, "update-pr-only");
    debugLog(`auto PR update: ${output}`);
    prAutoUpdateFailureShown = false;
    if (output.startsWith("No open pull request")) {
      prState = "none";
    } else {
      prState = "open";
      vscode.window.setStatusBarMessage("$(git-pull-request) AI attribution updated on PR", 5000);
    }
    actionsPanelProvider?.postPrState();
  } catch (error) {
    debugLog(`auto PR update failed: ${(error as Error).message}`);
    if (!prAutoUpdateFailureShown) {
      prAutoUpdateFailureShown = true;
      vscode.window.showWarningMessage(`AI Co-Authoring Tracker: couldn't auto-update the PR after push. ${(error as Error).message}`);
    }
  } finally {
    prAutoUpdateRunning = false;
    if (prAutoUpdatePending) {
      prAutoUpdatePending = false;
      void autoUpdatePrAfterPush(repoRoot);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionInstallPath = context.extensionPath;
  void checkGhPrerequisite(context);
  // Always keep the global per-machine copy current (silent, no prompt -- see
  // syncGlobalSignalHookScript), then, only if it isn't registered in the user's
  // ~/.claude/settings.json yet, ask once whether to register it (see promptInstallGlobalSignalHook).
  syncGlobalSignalHookScript(getRepoRoot());
  void promptInstallGlobalSignalHook(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "aiCoauthoringTracker.selectProvider";
  renderStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  statsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statsStatusBar.command = "aiCoauthoringTracker.showStats";
  statsStatusBar.show();
  context.subscriptions.push(statsStatusBar);

  statsOutputChannel = vscode.window.createOutputChannel("AI Co-Authoring Tracker Stats");
  context.subscriptions.push(statsOutputChannel);

  debugOutputChannel = vscode.window.createOutputChannel("AI Co-Authoring Tracker Debug");
  context.subscriptions.push(debugOutputChannel);

  statsTreeProvider = new AiStatsTreeDataProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("aiCoauthoringTrackerStats", statsTreeProvider));

  actionsPanelProvider = new AiCoauthoringTrackerPanelProvider(context.extensionUri);
  context.subscriptions.push(
    // retainContextWhenHidden keeps this view's page alive while it isn't visible (e.g. the user
    // switched to Source Control to run a git command) instead of tearing it down and rebuilding
    // it from scratch next time it's shown -- avoiding both the flash back to static placeholder
    // content and the postMessage-before-listener-is-ready race that caused it. This is a
    // WebviewView registration option, not a Webview.options field -- it only takes effect here.
    vscode.window.registerWebviewViewProvider(AiCoauthoringTrackerPanelProvider.viewType, actionsPanelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const repoRoot = getRepoRoot();
  if (repoRoot) {
    void promptInstallHooks(context, repoRoot);
    syncRepoHooksIfInstalled(context, repoRoot);
    migrateLegacyCharStatsIfNeeded(repoRoot);
    loadCharStatsForBranch(repoRoot, getCurrentBranchCached(repoRoot));
    startClaudeSignalWatcher(repoRoot);
    startHeadWatcher(repoRoot);
    startGitOperationWatcher(repoRoot);
    startRemoteRefWatcher(repoRoot);
    void refreshPrState(repoRoot);
  }
  renderStatsStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.selectProvider", async () => {
      await detectProviderFromQuickPick();
    })
  );

  context.subscriptions.push(
    // Takes an optional provider id (as posted by the sidebar's provider radio group). With no
    // id -- e.g. invoked from the Command Palette -- falls back to the configured provider
    // auto-detect would have picked, same as before a session is ever started.
    vscode.commands.registerCommand("aiCoauthoringTracker.startProvider", (providerId?: unknown) => {
      const configured = getConfiguredProviders();
      const requested = typeof providerId === "string" ? findProviderConfig(providerId) : undefined;
      const fallback = configured.find((p) => p.id === guessProviderForAutoDetection()) ?? configured[0];
      const config = requested ?? fallback;
      if (!config) return;
      setActiveProvider(config.id, "manual command");
      vscode.window.showInformationMessage(`${config.label} attribution enabled temporarily.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.clear", () => {
      const root = getRepoRoot();
      clearActiveSession();
      if (root) clearState(root, getCurrentBranchCached(root));
      vscode.window.showInformationMessage("AI attribution cleared.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.installClaudeSignalHook", async () => {
      syncGlobalSignalHookScript(getRepoRoot());
      if (isSignalHookRegisteredGlobally()) {
        vscode.window.showInformationMessage("AI Co-Authoring Tracker: Claude Code activity-signal hook is already installed globally.");
        return;
      }
      const installed = await installGlobalSignalHook();
      if (installed) {
        vscode.window.showInformationMessage("AI Co-Authoring Tracker: Claude Code activity-signal hook installed globally.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.toggleDebugLogging", async () => {
      const config = vscode.workspace.getConfiguration("aiCoauthoringTracker");
      const next = !isDebugLoggingEnabled();
      await config.update("debugLogging", next, vscode.ConfigurationTarget.Global);
      if (next) {
        debugOutputChannel.appendLine(`Debug logging enabled. Copilot extensions seen right now: ${describeCopilotExtensions()}`);
        debugOutputChannel.show(true);
        vscode.window.showInformationMessage(
          "AI Co-Authoring Tracker debug logging is ON. Reproduce the edit you want to diagnose, then check the \"AI Co-Authoring Tracker Debug\" output channel."
        );
      } else {
        vscode.window.showInformationMessage("AI Co-Authoring Tracker debug logging is OFF.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.showStats", () => {
      showCharStatsDebugInfo();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.resetStats", async () => {
      await resetCharStatsForActiveFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.refreshStats", () => {
      debugLog("refreshStats: re-rendering status bar and sidebar from in-memory state (no recalculation)");
      renderStatsStatusBar();
      statsTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.recalculateStats", () => {
      debugLog("recalculateStats requested");
      recalculateStatsFromGit();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.showBranchReport", () => {
      showBranchReport();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.resetBranchStats", async () => {
      await resetCurrentBranchStats();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.resetAllStats", async () => {
      await resetAllAttributionData();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.previewCommitTrailer", () => {
      previewCommitTrailer();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.previewPrSummary", () => {
      previewPrSummary();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.createPullRequest", async () => {
      await createPullRequest();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.updatePullRequest", async () => {
      await updatePullRequest();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.createOrUpdatePullRequest", async () => {
      await createOrUpdatePullRequest();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.reinstallHooksForThisRepo", async () => {
      await reinstallHooksForThisRepo(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiCoauthoringTracker.listInstalledRepos", async () => {
      await listInstalledRepos(context);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      const immediateUndoMatches = findImmediateUndoMatches(event);
      handleTextDocumentChangeEvent(event, immediateUndoMatches);
      trackCharacterStats(event, immediateUndoMatches);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      maybeTrackDocumentChange(document);
    })
  );

  const interval = setInterval(() => renderStatusBar(), 5000);
  context.subscriptions.push({
    dispose: () => clearInterval(interval),
  });
}

export function deactivate() {
  stopClaudeSignalWatcher();
  stopHeadWatcher();
  stopGitOperationWatcher();
  stopRemoteRefWatcher();
  if (statsPersistTimer) clearTimeout(statsPersistTimer);
  const repoRoot = getRepoRoot();
  if (repoRoot && charStats.size > 0 && statsLoadedForBranch) {
    persistCharStatsNow(repoRoot, statsLoadedForBranch);
  }
}
