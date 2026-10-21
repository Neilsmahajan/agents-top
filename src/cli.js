// Command-line interface. Results go to stdout, diagnostics to stderr.

import os from "node:os";
import { join } from "node:path";
import { createTranscriptReader } from "./claude.js";
import {
  cwdsFor as defaultCwdsFor,
  listProcesses as defaultListProcesses,
  isClaudeProcess,
  isCodexProcess,
} from "./process.js";
import { makeColors, render } from "./render.js";
import { buildSnapshot, SCHEMA_VERSION } from "./snapshot.js";
import { VERSION } from "./version.js";

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2 };

// Longest timer Node supports (2^31-1 ms), in whole seconds.
const MAX_INTERVAL = 2_147_483;

export const HELP = `agents-top ${VERSION} — a \`top\` for coding-agent sessions

Shows every Claude Code session running on this machine (directory, model,
context size, output tokens, current tool, title) and every Codex CLI process.

usage: agents-top [--json] [-w [secs]] [--no-color]

  (no args)          one snapshot, then exit
  -w, --watch [secs] live view, refreshed every secs seconds (default 2).
                     Needs a terminal; otherwise prints one snapshot.
  --json             one snapshot as JSON (schema version ${SCHEMA_VERSION}) on stdout
  --no-color         plain text (also when NO_COLOR is set or stdout is not a terminal)
  -V, --version      print the version
  -h, --help         this help

What each provider reports:
  Claude Code   process, directory, model, context and output tokens,
                current/last tool, title, git branch (from its transcripts)
  Codex         process, directory, kind, sandbox only. No model, tokens or tool.
  Cursor        not supported

Columns (Claude Code):
  state  ● active: transcript written in the last 30s
         ⚠ waiting: a tool call has no result and nothing written for 30s+
         ◌ idle    ? no transcript found
  DIR    ≈ suffix: transcript matched by directory (guess, see below)
  CTX    tokens in the last request's context; yellow over 120k, red over 180k
  OUT    output tokens this session, including subagents
  TOOL   pending (cyan) or last (dim) tool; chrome:/computer: tools share one
         browser/desktop

Heuristics (guesses, not facts):
  perm?   a tool call has no result yet and the transcript hasn't changed
          for over 60s. Often a permission prompt, but a long-running command
          looks the same. Never shown in bypassPermissions mode or for
          AskUserQuestion.
  ≈       no --session-id on the command line, so the newest unclaimed
          transcript in the session's directory is used. Two sessions in one
          directory can be swapped.
  active  based on when the transcript file last changed.
  Chrome / computer-use warnings: sessions that called those tools in the
          last 15 minutes or are waiting on one now; two or more may contend.

Environment:
  CLAUDE_CONFIG_DIR  Claude Code config directory (default ~/.claude)
  NO_COLOR           disable color

Exit codes:
  0  success (including when no agents are running)
  1  runtime error (for example, ps could not run, or in -w the last
     refresh before quitting failed; the message is on stderr)
  2  usage error (unknown option or bad interval)

Limits: ps flattens each process's arguments into one string, so a quoted
argument containing spaces (a -C path, a -p prompt that mentions
--session-id) can be misread.

Read-only: agents-top never writes to transcripts or signals processes.`;

/** Parse argv. Returns { opts } or { error } (a usage error message). */
export function parseArgs(argv) {
  const opts = { json: false, watch: false, interval: 2, color: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-V" || a === "--version") opts.version = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--no-color") opts.color = false;
    else if (a === "-w" || a === "--watch" || a.startsWith("--watch=")) {
      opts.watch = true;
      let v = a.startsWith("--watch=") ? a.slice(8) : null;
      if (v == null && argv[i + 1] != null && !argv[i + 1].startsWith("-")) v = argv[++i];
      if (v != null) {
        const n = Number(v);
        if (!/^\d+(\.\d+)?$/.test(v) || !(n >= 0.5) || !(n <= MAX_INTERVAL))
          return { error: `invalid interval "${v}" (seconds, 0.5 to ${MAX_INTERVAL})` };
        opts.interval = n;
      }
    } else return { error: `unknown argument "${a}"` };
  }
  if (opts.json && opts.watch) return { error: "--json and --watch can't be combined; run --json repeatedly instead" };
  return { opts };
}

/**
 * Run the CLI. Returns an exit code, or for watch mode a promise that never
 * settles (the process exits on q / Ctrl-C).
 *
 * Every side effect is injectable so tests can run it in-process.
 */
export function main(
  argv,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    listProcesses = defaultListProcesses,
    cwdsFor = defaultCwdsFor,
    home = os.homedir(),
    now = () => Date.now(),
    exit = (code) => process.exit(code),
    signals = process,
    every = (fn, ms) => setInterval(fn, ms),
  } = {},
) {
  const write = (s) => stdout.write(`${s}\n`);
  const warn = (s) => stderr.write(`agents-top: ${s}\n`);

  const parsed = parseArgs(argv);
  if (parsed.error) {
    warn(parsed.error);
    stderr.write("Try 'agents-top --help'.\n");
    return EXIT.USAGE;
  }
  const { opts } = parsed;
  if (opts.help) return write(HELP), EXIT.OK;
  if (opts.version) return write(VERSION), EXIT.OK;

  const projectsDir = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
  const readTranscript = createTranscriptReader();
  const sidCache = new Map();
  const take = () => {
    const procs = listProcesses();
    const agentPids = procs.filter((p) => isClaudeProcess(p.args) || isCodexProcess(p.args)).map((p) => p.pid);
    return buildSnapshot({ procs, cwds: cwdsFor(agentPids), projectsDir, readTranscript, now: now(), sidCache });
  };

  const isTTY = Boolean(stdout.isTTY);
  const color = opts.color && isTTY && !env.NO_COLOR;
  const renderOpts = () => ({ color, width: stdout.columns || 140, home });

  let snap;
  try {
    snap = take();
  } catch (e) {
    warn(`could not read processes: ${e?.message ?? e}`);
    return EXIT.ERROR;
  }

  if (opts.json) {
    write(JSON.stringify({ tool: "agents-top", toolVersion: VERSION, ...snap }, null, 2));
    return EXIT.OK;
  }
  if (!opts.watch) return write(render(snap, renderOpts())), EXIT.OK;
  if (!isTTY) {
    warn("stdout is not a terminal; printing one snapshot instead of a live view");
    return write(render(snap, renderOpts())), EXIT.OK;
  }

  // Live view: alternate screen, redraw every interval, q or Ctrl-C to quit.
  // A failed refresh is shown in the view and retried on the next tick; if
  // the last refresh before quitting failed, the error goes to stderr (after
  // the screen is restored) and the exit code is 1.
  const { dim, red } = makeColors(color);
  let lastError = null;
  stdout.write("\x1b[?1049h\x1b[?25l");
  const cleanup = () => {
    stdout.write("\x1b[?1049l\x1b[?25h");
    if (stdin.isTTY) stdin.setRawMode(false);
    if (lastError) warn(`refresh failed: ${lastError}`);
    exit(lastError ? EXIT.ERROR : EXIT.OK);
  };
  signals.on("SIGINT", cleanup);
  signals.on("SIGTERM", cleanup);
  const draw = (s) => {
    let body;
    try {
      body = render(s ?? take(), renderOpts());
      lastError = null;
    } catch (e) {
      lastError = e?.message ?? String(e);
      body = red(`refresh failed: ${lastError} (retrying)`);
    }
    stdout.write(`\x1b[2J\x1b[H${body}${dim(`\n\n  refresh ${opts.interval}s — q or Ctrl-C to quit`)}\n`);
  };
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (d) => {
      const k = d.toString();
      if (k === "q" || k === "Q" || k === "\x03") cleanup();
    });
  }
  draw(snap);
  every(() => draw(), opts.interval * 1000);
  return new Promise(() => {});
}
