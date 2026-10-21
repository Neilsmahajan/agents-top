// Build one snapshot of every agent session: processes joined with their
// transcripts, plus the heuristic flags. Pure apart from transcript reads, so
// tests can pass in a synthetic process list.

import { basename, isAbsolute, resolve } from "node:path";
import { findTranscript, sharedKind } from "./claude.js";
import { argAt, claudeArgStart, etimeToSeconds, isClaudeProcess, isCodexProcess } from "./process.js";

export const SCHEMA_VERSION = 1;

// Heuristic thresholds. Documented in the README and --help.
export const ACTIVE_MS = 30_000; // transcript written this recently → "active"
export const PERMISSION_GUESS_MS = 60_000; // tool unanswered this long → "possible permission prompt"
export const SHARED_WINDOW_MS = 15 * 60_000; // "recent" use of Chrome / computer use

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * @param {object} o
 * @param {Array} o.procs            parsed `ps` rows
 * @param {Record<number,string>} o.cwds  pid -> cwd
 * @param {string} o.projectsDir     Claude Code projects dir
 * @param {(path:string)=>object|null} o.readTranscript
 * @param {number} [o.now]
 * @param {Map} [o.sidCache]         session id -> transcript path, reused across refreshes
 */
export function buildSnapshot({ procs, cwds, projectsDir, readTranscript, now = Date.now(), sidCache }) {
  const claudeProcs = procs.filter((p) => isClaudeProcess(p.args));
  // `claude remote-control` is a subcommand, so it must be the first argument.
  const rcHosts = claudeProcs.filter((p) => argAt(p.args, claudeArgStart(p.args)) === "remote-control");
  const claudeSessions = claudeProcs.filter((p) => !rcHosts.includes(p));

  // A launcher that runs the real binary with the same arguments in the same
  // directory shows up twice; keep only the child. A Codex session that starts
  // another Codex command (say, `codex exec`) is a separate session and stays.
  const allCodex = procs.filter((p) => isCodexProcess(p.args));
  const tail = (p) => p.args.split(/\s+/).slice(1).join(" ");
  const isLauncherOf = (parent, child) =>
    child.ppid === parent.pid && tail(child) === tail(parent) && cwds[child.pid] === cwds[parent.pid];
  const codexProcs = allCodex.filter((p) => !allCodex.some((q) => isLauncherOf(p, q)));

  // Exact (--session-id) matches claim their transcripts first, so the
  // cwd-based guess for other processes can't take them.
  const withSid = claudeSessions.map((p) => ({
    p,
    sid: p.args.match(/--session-id[= ]([A-Za-z0-9_-]+)/)?.[1] ?? null,
  }));
  const ordered = [...withSid.filter((x) => x.sid), ...withSid.filter((x) => !x.sid)];
  const claimed = new Set();
  const sessions = [];
  for (const { p, sid } of ordered) {
    const cwd = cwds[p.pid] ?? null;
    const found = findTranscript({ projectsDir, sessionId: sid, cwd, claimed, sidCache });
    if (found) claimed.add(found.path);
    const t = found ? readTranscript(found.path) : null;
    const idleMs = t ? Math.max(0, now - t.mtimeMs) : null;
    const pendingTools = t ? [...t.pending.values()] : [];
    const pendingTool = pendingTools.at(-1) ?? null;
    let state = "unknown";
    if (idleMs != null) state = idleMs < ACTIVE_MS ? "active" : pendingTool ? "waiting" : "idle";
    sessions.push({
      pid: p.pid,
      ppid: p.ppid,
      uptime: p.etime,
      uptimeSeconds: etimeToSeconds(p.etime),
      cpuPercent: p.cpu,
      rssKb: p.rssKb,
      cwd,
      headless: /\s(-p|--print)(\s|$)/.test(p.args),
      sessionId: sid ?? (found ? basename(found.path, ".jsonl") : null),
      transcript: found ? { path: found.path, match: found.match } : null,
      model: t?.model ?? null,
      contextTokens: t ? t.contextTokens : null,
      outputTokens: t ? t.outputTokens : null,
      title: t?.title ?? null,
      gitBranch: t?.gitBranch ?? null,
      permissionMode: t?.permissionMode ?? null,
      lastTool: t?.lastTool ?? null,
      pendingTool,
      pendingTools,
      lastActivityAt: iso(t?.mtimeMs),
      idleSeconds: idleMs == null ? null : Math.round(idleMs / 1000),
      state,
      possiblePermissionPrompt: possiblePermissionPrompt({ pendingTool, idleMs, permissionMode: t?.permissionMode }),
      sharedResourcesLastUsed: {
        chrome: iso(t?.shared.chrome),
        computerUse: iso(t?.shared.computerUse),
      },
    });
  }
  sessions.sort((a, b) => (a.idleSeconds ?? Number.POSITIVE_INFINITY) - (b.idleSeconds ?? Number.POSITIVE_INFINITY));

  const codex = codexProcs.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    uptime: p.etime,
    uptimeSeconds: etimeToSeconds(p.etime),
    cpuPercent: p.cpu,
    rssKb: p.rssKb,
    kind: p.args.includes("ChatGPT.app") ? "chatgpt-app" : /\sexec(\s|$)/.test(p.args) ? "cli-exec" : "cli",
    cwd: codexDir(p, cwds[p.pid] ?? null),
    sandbox: p.args.match(/--sandbox[= ](\S+)/)?.[1] ?? null,
  }));

  const remoteControlHosts = rcHosts.map((p) => ({
    pid: p.pid,
    uptime: p.etime,
    uptimeSeconds: etimeToSeconds(p.etime),
    name: p.args.match(/--remote-control-session-name-prefix[= ](\S+)/)?.[1] ?? null,
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: iso(now),
    claude: { sessions, remoteControlHosts },
    codex: { processes: codex },
    sharedResources: sharedResourceUse(sessions, now),
  };
}

/** Codex's working directory: its -C/--cd option (resolved against the process cwd), else the process cwd. */
function codexDir(p, cwd) {
  const dir = p.args.match(/\s(?:-C|--cd)[= ](\S+)/)?.[1];
  if (!dir) return cwd;
  return isAbsolute(dir) || !cwd ? dir : resolve(cwd, dir);
}

/**
 * Heuristic: a tool call still has no result and the transcript hasn't
 * changed for over a minute. That often means Claude Code is waiting on a
 * permission prompt, but a long-running command looks the same. Never flagged in bypassPermissions mode, which doesn't prompt,
 * or for AskUserQuestion, which is a question, not a permission prompt.
 */
export function possiblePermissionPrompt({ pendingTool, idleMs, permissionMode }) {
  if (!pendingTool || idleMs == null || idleMs < PERMISSION_GUESS_MS) return false;
  if (permissionMode === "bypassPermissions") return false;
  if (pendingTool === "AskUserQuestion") return false;
  return true;
}

/**
 * Heuristic: sessions that called Chrome or computer-use tools in the last
 * 15 minutes, or are waiting on one now. Two or more at once risk fighting
 * over the one browser/desktop.
 */
export function sharedResourceUse(sessions, now) {
  const out = [];
  for (const resource of ["chrome", "computerUse"]) {
    const inUse = (s) => s.pendingTools.some((t) => sharedKind(t) === resource);
    const users = sessions.filter((s) => {
      if (inUse(s)) return true;
      const t = s.sharedResourcesLastUsed[resource];
      return t && now - Date.parse(t) < SHARED_WINDOW_MS;
    });
    if (!users.length) continue;
    out.push({
      resource,
      sessions: users.map((s) => ({ pid: s.pid, inUseNow: inUse(s) })),
      contention: users.length > 1,
    });
  }
  return out;
}
