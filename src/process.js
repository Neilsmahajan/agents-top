// Process discovery: which agent processes are running, and where.
//
// Read-only. Uses `ps` everywhere, then `/proc/<pid>/cwd` on Linux or `lsof`
// on macOS for each process's working directory.

import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename } from "node:path";

/** Run `ps` and return one object per process. */
export function listProcesses() {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,etime=,pcpu=,rss=,args="], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return parsePs(out);
}

/** Parse `ps -o pid=,ppid=,etime=,pcpu=,rss=,args=` output. */
export function parsePs(out) {
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: +m[1],
      ppid: +m[2],
      etime: m[3],
      cpu: Number.parseFloat(m[4]) || 0,
      rssKb: +m[5],
      args: m[6],
    });
  }
  return procs;
}

/** `ps` elapsed time ("[[dd-]hh:]mm:ss") to seconds; null if unparseable. */
export function etimeToSeconds(etime) {
  const m = String(etime).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((+d * 24 + +h) * 60 + +min) * 60 + +s;
}

/** Map pid -> current working directory. Missing pids are simply absent. */
export function cwdsFor(pids, { platform = process.platform } = {}) {
  const map = {};
  if (!pids.length) return map;
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        map[pid] = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
    }
    if (Object.keys(map).length === pids.length) return map;
  }
  let out = "";
  try {
    out = execFileSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // lsof exits 1 when any pid has gone away; its stdout is still valid.
    out = typeof e?.stdout === "string" ? e.stdout : "";
  }
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = +line.slice(1);
    else if (line.startsWith("n") && pid != null && !(pid in map)) map[pid] = line.slice(1);
  }
  return map;
}

// `ps` flattens argv into one string, so quoting is lost: an argument with a
// space in it can't be told apart from two. Only argument positions that
// can't contain user text (the executable, the subcommand) are trusted.
export const argAt = (args, i) => args.split(/\s+/)[i] ?? "";
const argv0 = (args) => argAt(args, 0);

/**
 * Is this a Claude Code process? Matched on the executable, not on any
 * mention of "claude" in the arguments, so shells and tmux lines that merely
 * launch it don't count. Covers the `claude` launcher, the native installer's
 * versioned binary (used when other tools spawn it directly), and npm installs.
 */
export function isClaudeProcess(args) {
  const exe = argv0(args);
  const name = basename(exe);
  if (name === "claude") return true;
  if (/\/claude\/versions\/[^/]+$/.test(exe)) return true;
  if ((name === "node" || name === "bun") && /\/@anthropic-ai\/claude-code\/cli\.js$/.test(argAt(args, 1))) return true;
  return false;
}

/** Is this a Codex CLI (or Codex app helper) process? Matched on the executable. */
export function isCodexProcess(args) {
  return basename(argv0(args)) === "codex";
}
