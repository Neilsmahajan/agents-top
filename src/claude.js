// Claude Code transcripts: <config dir>/projects/<encoded cwd>/<session id>.jsonl
//
// Each line is one JSON record. agents-top reads them read-only and
// incrementally (only the bytes appended since the last refresh), and keeps
// just the fields it shows: model, context and output tokens, title, branch,
// permission mode, and the last / still-unanswered tool call.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Which shared, single-instance resource a tool name contends for, if any. */
export function sharedKind(toolName) {
  if (!toolName) return null;
  if (toolName.startsWith("mcp__claude-in-chrome__")) return "chrome";
  if (toolName.startsWith("mcp__computer-use__")) return "computerUse";
  return null;
}

export function freshState() {
  return {
    model: null,
    contextTokens: 0,
    outputTokens: 0,
    msgOut: new Map(), // message id -> output tokens already counted
    title: null,
    gitBranch: null,
    permissionMode: null,
    lastTool: null,
    pending: new Map(), // tool_use id -> tool name, until its tool_result arrives
    shared: {}, // sharedKind -> last use (ms since epoch)
  };
}

/** Fold one transcript record into the running state. */
export function applyRecord(st, rec, fileMtimeMs = Date.now()) {
  if (!rec || typeof rec !== "object") return;
  const ts = rec.timestamp ? Date.parse(rec.timestamp) || fileMtimeMs : fileMtimeMs;
  if (rec.gitBranch) st.gitBranch = rec.gitBranch;
  if (rec.type === "ai-title" && rec.aiTitle) st.title = rec.aiTitle;
  if (rec.type === "permission-mode" && rec.mode) st.permissionMode = rec.mode;
  else if (rec.type === "user" && rec.permissionMode) st.permissionMode = rec.permissionMode;

  // Subagent turns (isSidechain) cost output tokens but are not the main
  // conversation's context or current tool.
  const main = !rec.isSidechain;
  const msg = rec.message;
  if (rec.type === "assistant" && msg) {
    // "<synthetic>" records are written by Claude Code itself (errors,
    // interruptions) with zero usage; they aren't requests.
    const synthetic = msg.model === "<synthetic>";
    if (main && msg.model && !synthetic) st.model = msg.model;
    const u = msg.usage;
    if (u && !synthetic) {
      if (main)
        st.contextTokens =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const out = u.output_tokens || 0;
      // One API message is written as several records (one per content
      // block) that repeat its id and usage, possibly interleaved with other
      // messages; count each message once, at its latest value.
      if (msg.id) {
        st.outputTokens += out - (st.msgOut.get(msg.id) ?? 0);
        st.msgOut.set(msg.id, out);
      } else st.outputTokens += out;
    }
    if (main && Array.isArray(msg.content))
      for (const b of msg.content)
        if (b?.type === "tool_use") {
          st.pending.set(b.id, b.name);
          st.lastTool = b.name;
          const k = sharedKind(b.name);
          if (k) st.shared[k] = ts;
        }
  }
  if (rec.type === "user" && msg && Array.isArray(msg.content))
    for (const b of msg.content) if (b?.type === "tool_result" && b.tool_use_id) st.pending.delete(b.tool_use_id);
}

const TAIL_BYTES = 64;

/**
 * Transcripts are append-only. If the bytes just before where we stopped
 * reading have changed, the file was rewritten and must be re-read. (A
 * same-size rewrite that keeps those bytes would go unnoticed; Claude Code
 * doesn't do that.)
 */
function tailUnchanged(path, entry) {
  if (!entry.tail.length) return true;
  const buf = Buffer.alloc(entry.tail.length);
  let fd;
  try {
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, entry.offset - entry.tail.length);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return buf.equals(entry.tail);
}

/**
 * A transcript reader with a per-file cache, so repeated refreshes (watch
 * mode) only parse newly appended lines.
 */
export function createTranscriptReader() {
  const cache = new Map(); // path -> { ino, offset, rest, tail, state }
  return function readTranscript(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    let entry = cache.get(path);
    if (!entry || entry.ino !== stat.ino || stat.size < entry.offset || !tailUnchanged(path, entry)) {
      entry = { ino: stat.ino, offset: 0, rest: Buffer.alloc(0), tail: Buffer.alloc(0), state: freshState() };
      cache.set(path, entry);
    }
    if (stat.size > entry.offset) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(4 * 1024 * 1024);
        while (entry.offset < stat.size) {
          const n = readSync(fd, buf, 0, buf.length, entry.offset);
          if (n <= 0) break;
          entry.offset += n;
          entry.tail = Buffer.from(Buffer.concat([entry.tail, buf.subarray(0, n)]).subarray(-TAIL_BYTES));
          // Decode only whole lines; keep a trailing partial line (possibly
          // mid-character) as bytes until the rest of it is written.
          const bytes = Buffer.concat([entry.rest, buf.subarray(0, n)]);
          const cut = bytes.lastIndexOf(0x0a) + 1;
          entry.rest = Buffer.from(bytes.subarray(cut));
          for (const line of bytes.toString("utf8", 0, cut).split("\n")) {
            if (!line) continue;
            try {
              applyRecord(entry.state, JSON.parse(line), stat.mtimeMs);
            } catch {}
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    const { msgOut, ...state } = entry.state;
    return { ...state, pending: new Map(state.pending), mtimeMs: stat.mtimeMs, path };
  };
}

/**
 * Claude Code's project directory name for a cwd. Current versions replace
 * every non-alphanumeric character with "-"; older ones replaced only "/"
 * and ".". Both are tried.
 */
export function projectDirNames(cwd) {
  return [...new Set([cwd.replace(/[^a-zA-Z0-9]/g, "-"), cwd.replace(/[/.]/g, "-")])];
}

/**
 * Find the transcript for a process.
 *
 * - With a session id (`--session-id`), the match is exact.
 * - Without one, the newest transcript in the cwd's project directory that no
 *   other process has claimed is used. This is a heuristic: two sessions
 *   started in the same directory can be swapped.
 *
 * Returns { path, match: "session-id" | "cwd-newest" } or null.
 */
export function findTranscript({ projectsDir, sessionId, cwd, claimed, sidCache = new Map() }) {
  if (sessionId) {
    const cached = sidCache.get(sessionId);
    if (cached && existsSync(cached)) return { path: cached, match: "session-id" };
    const dirs = cwd ? projectDirNames(cwd) : [];
    for (const d of dirs) {
      const p = join(projectsDir, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return sidCache.set(sessionId, p), { path: p, match: "session-id" };
    }
    try {
      for (const d of readdirSync(projectsDir)) {
        const p = join(projectsDir, d, `${sessionId}.jsonl`);
        if (existsSync(p)) return sidCache.set(sessionId, p), { path: p, match: "session-id" };
      }
    } catch {}
    // Not written yet (or stored under another name). Guessing by cwd here
    // could pick up a different, finished session, so report no transcript.
    return null;
  }
  if (!cwd) return null;
  for (const d of projectDirNames(cwd)) {
    const dir = join(projectsDir, d);
    let cands;
    try {
      cands = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(dir, f))
        .filter((p) => !claimed.has(p))
        .map((p) => ({ p, m: statSync(p).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    } catch {
      continue;
    }
    if (cands.length) return { path: cands[0].p, match: "cwd-newest" };
  }
  return null;
}
