import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, HELP, main, parseArgs } from "../src/cli.js";
import { fmtAge, fmtTokens, render, shortModel, shortTool } from "../src/render.js";
import { VERSION } from "../src/version.js";
import { age, claudeHome, proc, ROOT, S1, S3, transcriptPath, validator } from "./helpers.js";

const ANSI = /\x1b\[/;

function sink(isTTY = false) {
  const chunks = [];
  return {
    isTTY,
    columns: 160,
    write(s) {
      chunks.push(s);
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

function run(argv, { tty = false, env = {}, procs, cwds } = {}) {
  const home = claudeHome();
  const now = Date.now();
  age(transcriptPath(home, "-work-demo-app", S1), now, 3_000);
  age(transcriptPath(home, "-work-api-server", S3), now, 5 * 60_000);
  const stdout = sink(tty);
  const stderr = sink(false);
  const code = main(argv, {
    env: { CLAUDE_CONFIG_DIR: home, ...env },
    stdout,
    stderr,
    stdin: { isTTY: false },
    home: "/work",
    now: () => now,
    listProcesses: () =>
      procs ?? [
        proc(10, `/usr/local/bin/claude --session-id ${S1}`),
        proc(20, `/usr/local/bin/claude --session-id ${S3}`),
        proc(30, "/usr/local/bin/codex --sandbox workspace-write"),
      ],
    cwdsFor: () => cwds ?? { 10: "/work/demo-app", 20: "/work/api-server", 30: "/work/demo-app" },
    exit: () => {},
  });
  return { code, out: stdout.text, err: stderr.text };
}

describe("argument parsing", () => {
  test.each([
    [[], { json: false, watch: false, interval: 2, color: true }],
    [["--json"], { json: true }],
    [["-w"], { watch: true, interval: 2 }],
    [["-w", "5"], { watch: true, interval: 5 }],
    [["--watch=0.5"], { watch: true, interval: 0.5 }],
    [["-w", "--no-color"], { watch: true, interval: 2, color: false }],
  ])("%j", (argv, want) => expect(parseArgs(argv).opts).toMatchObject(want));

  test.each([
    [["--bogus"], /unknown argument/],
    [["extra"], /unknown argument/],
    [["-w", "0"], /invalid interval/],
    [["-w", "abc"], /invalid interval/],
    [["--watch=-1"], /invalid interval/],
    [["--json", "-w"], /can't be combined/],
    [["-w", "9".repeat(400)], /invalid interval/],
    [["-w", "3000000"], /invalid interval/],
  ])("%j is a usage error", (argv, msg) => expect(parseArgs(argv).error).toMatch(msg));
});

describe("agent contract", () => {
  test("--json: versioned schema on stdout, nothing on stderr, exit 0", () => {
    const { code, out, err } = run(["--json"]);
    expect(code).toBe(EXIT.OK);
    expect(err).toBe("");
    const doc = JSON.parse(out);
    const validate = validator();
    expect(validate(doc)).toBe(true);
    expect(doc).toMatchObject({ tool: "agents-top", toolVersion: VERSION, schemaVersion: 1 });
    expect(doc.claude.sessions.map((s) => s.pid)).toEqual([10, 20]);
    expect(doc.codex.processes[0]).toMatchObject({ pid: 30, kind: "cli", sandbox: "workspace-write" });
    expect(out).not.toMatch(ANSI);
  });

  test("usage errors exit 2 with the message on stderr and nothing on stdout", () => {
    const { code, out, err } = run(["--frobnicate"]);
    expect(code).toBe(EXIT.USAGE);
    expect(out).toBe("");
    expect(err).toContain('unknown argument "--frobnicate"');
  });

  test("runtime errors exit 1 with the message on stderr", () => {
    const stdout = sink();
    const stderr = sink();
    const code = main([], {
      stdout,
      stderr,
      listProcesses: () => {
        throw new Error("ps: not found");
      },
    });
    expect(code).toBe(EXIT.ERROR);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("ps: not found");
  });

  test("--watch without a terminal prints one snapshot instead of a TUI", () => {
    const { code, out, err } = run(["--watch", "1"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("agents-top");
    expect(out).not.toMatch(/\x1b\[\?1049h/); // no alternate screen
    expect(out).not.toMatch(ANSI);
    expect(err).toContain("not a terminal");
  });

  test("color only on a terminal, and never with NO_COLOR or --no-color", () => {
    expect(run([], { tty: true }).out).toMatch(ANSI);
    expect(run([]).out).not.toMatch(ANSI);
    expect(run([], { tty: true, env: { NO_COLOR: "1" } }).out).not.toMatch(ANSI);
    expect(run(["--no-color"], { tty: true }).out).not.toMatch(ANSI);
  });

  test("no agents running is a success", () => {
    const { code, out } = run([], { procs: [], cwds: {} });
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("no Claude Code sessions running");
  });

  test("--help documents providers, heuristics and exit codes", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`${HELP}\n`);
    for (const s of ["Codex", "process, directory, kind, sandbox only", "Cursor", "not supported"])
      expect(HELP).toContain(s);
    expect(HELP).toMatch(/Heuristics \(guesses, not facts\)/);
    for (const s of ["perm?", "≈", "Exit codes", "0  success", "1  runtime error", "2  usage error"])
      expect(HELP).toContain(s);
  });

  test("--version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(run(["--version"]).out).toBe(`${pkg.version}\n`);
  });
});

describe("live view", () => {
  test("a failed refresh is shown, then reported on stderr with exit 1 after quitting", () => {
    let calls = 0;
    let tick;
    let exitCode;
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const stdout = sink(true);
    const stderr = sink();
    main(["-w", "1"], {
      env: { CLAUDE_CONFIG_DIR: claudeHome() },
      stdout,
      stderr,
      stdin,
      signals: new EventEmitter(),
      every: (fn) => {
        tick = fn;
      },
      exit: (c) => {
        exitCode = c;
      },
      listProcesses: () => {
        if (++calls > 1) throw new Error("ps went away");
        return [];
      },
      cwdsFor: () => ({}),
    });
    tick();
    expect(stdout.text).toContain("refresh failed: ps went away");
    expect(stderr.text).toBe("");
    stdin.emit("data", Buffer.from("q"));
    expect(exitCode).toBe(EXIT.ERROR);
    expect(stderr.text).toContain("refresh failed: ps went away");
    expect(stdout.text.endsWith("\x1b[?1049l\x1b[?25h")).toBe(true);
  });

  test("a refresh error with an empty message still exits 1", () => {
    let calls = 0;
    let tick;
    let exitCode;
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const stderr = sink();
    main(["-w"], {
      env: { CLAUDE_CONFIG_DIR: claudeHome() },
      stdout: sink(true),
      stderr,
      stdin,
      signals: new EventEmitter(),
      every: (fn) => {
        tick = fn;
      },
      exit: (c) => {
        exitCode = c;
      },
      listProcesses: () => {
        if (++calls > 1) throw new Error("");
        return [];
      },
      cwdsFor: () => ({}),
    });
    tick();
    stdin.emit("data", Buffer.from("q"));
    expect(exitCode).toBe(EXIT.ERROR);
    expect(stderr.text).toContain("refresh failed");
  });

  test("quitting after a good refresh exits 0", () => {
    let exitCode;
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    main(["-w"], {
      env: { CLAUDE_CONFIG_DIR: claudeHome() },
      stdout: sink(true),
      stderr: sink(),
      stdin,
      signals: new EventEmitter(),
      every: () => {},
      exit: (c) => {
        exitCode = c;
      },
      listProcesses: () => [],
      cwdsFor: () => ({}),
    });
    stdin.emit("data", Buffer.from("q"));
    expect(exitCode).toBe(EXIT.OK);
  });
});

describe("text output", () => {
  test("shows sessions, labels guesses, and marks Codex as process-only", () => {
    const procs = [
      proc(10, `/usr/local/bin/claude --session-id ${S1}`),
      proc(11, "/usr/local/bin/claude"),
      proc(30, "/usr/local/bin/codex exec --sandbox read-only"),
    ];
    const { out } = run([], { procs, cwds: { 10: "/work/demo-app", 11: "/work/api-server", 30: "/work/demo-app" } });
    expect(out).toContain("~/demo-app");
    expect(out).toContain("Fix the login redirect");
    expect(out).toContain("opus-5-5");
    expect(out).toContain("chrome:navigate");
    expect(out).toContain("~/api-server ≈"); // matched by directory, a guess
    expect(out).toContain("codex (process info only)");
    expect(out).toMatch(/Chrome used in the last 15m by 1/);
  });

  test("perm? appears only for a quiet pending tool outside bypass mode", () => {
    const now = Date.now();
    const snap = (permissionMode) => ({
      generatedAt: new Date(now).toISOString(),
      claude: {
        sessions: [
          {
            pid: 1,
            cwd: "/w",
            headless: false,
            transcript: { path: "x", match: "session-id" },
            model: "claude-opus-5-5",
            contextTokens: 1000,
            outputTokens: 10,
            title: "t",
            permissionMode,
            lastTool: "Bash",
            pendingTool: "Bash",
            idleSeconds: 120,
            state: "waiting",
            possiblePermissionPrompt: permissionMode !== "bypassPermissions",
            cpuPercent: 0,
            uptime: "01:00",
          },
        ],
        remoteControlHosts: [],
      },
      codex: { processes: [] },
      sharedResources: [],
    });
    expect(render(snap("default"))).toContain("perm?");
    expect(render(snap("bypassPermissions"))).not.toContain("perm?");
  });

  test("control characters in transcript text can't reach the terminal", () => {
    const now = Date.now();
    const evil = "pwned\x1b[2J\nfake row\x07";
    const out = render({
      generatedAt: new Date(now).toISOString(),
      claude: {
        sessions: [
          {
            pid: 1,
            cwd: `/w/${evil}`,
            headless: false,
            transcript: { path: "x", match: "session-id" },
            model: `claude-${evil}`,
            contextTokens: 1,
            outputTokens: 1,
            title: evil,
            lastTool: evil,
            pendingTool: null,
            pendingTools: [],
            idleSeconds: 1,
            state: "active",
            possiblePermissionPrompt: false,
            cpuPercent: 0,
            uptime: "01:00",
          },
        ],
        remoteControlHosts: [{ pid: 2, uptime: "01:00", name: evil }],
      },
      codex: { processes: [{ pid: 3, kind: "cli", sandbox: evil, cwd: evil, uptime: "01:00" }] },
      sharedResources: [],
    });
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\nfake row");
  });

  test("formatters", () => {
    expect(fmtTokens(null)).toBe("?");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(43000)).toBe("43k");
    expect(fmtTokens(1_250_000)).toBe("1.3M");
    expect(fmtAge(5)).toBe("5s");
    expect(fmtAge(600)).toBe("10m");
    expect(fmtAge(5400)).toBe("1.5h");
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("sonnet-4-5");
    expect(shortModel(null)).toBe("?");
    expect(shortTool("mcp__computer-use__screenshot")).toBe("computer:screenshot");
    expect(shortTool("mcp__plugin_github_github__create_pull_request")).toBe("gh:create_pull_request");
  });
});
